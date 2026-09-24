import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'packages', 'obsidian-ai-rewrite');
const files = ['main.js', 'manifest.json', 'styles.css'];

async function existingFile(path) {
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`不是普通文件：${path}`);
}

async function fingerprint(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

export async function installPlugin(destination) {
  const target = resolve(destination);
  const dir = await stat(target);
  if (!dir.isDirectory()) throw new Error(`插件目录不存在：${target}`);

  const [sourceManifest, targetManifest, packageInfo] = await Promise.all([
    readFile(join(source, 'manifest.json'), 'utf8').then(JSON.parse),
    readFile(join(target, 'manifest.json'), 'utf8').then(JSON.parse),
    readFile(join(source, 'package.json'), 'utf8').then(JSON.parse),
  ]);
  if (sourceManifest.id !== 'obsidian-ai-rewrite' || targetManifest.id !== sourceManifest.id ||
      sourceManifest.version !== packageInfo.version) {
    throw new Error('插件 ID 或版本不一致，拒绝覆盖');
  }
  for (const file of files) {
    await existingFile(join(source, file));
    await existingFile(join(target, file));
  }

  const backup = join(root, '.tmp', 'obsidian-plugin-backup', `${Date.now()}-${randomUUID()}`);
  await mkdir(backup, { recursive: true });
  for (const file of files) await copyFile(join(target, file), join(backup, file));
  console.log(`旧版本备份：${backup}`);

  const replaced = [];
  let temporary = '';
  try {
    for (const file of files) {
      temporary = join(target, `.${file}.${randomUUID()}.tmp`);
      await copyFile(join(source, file), temporary);
      await rename(temporary, join(target, file));
      temporary = '';
      replaced.push(file);
      if (await fingerprint(join(source, file)) !== await fingerprint(join(target, file))) {
        throw new Error(`${file} 校验失败`);
      }
    }
  } catch (error) {
    if (temporary) await rm(temporary, { force: true });
    try {
      for (const file of replaced.reverse()) await copyFile(join(backup, file), join(target, file));
    } catch (restoreError) {
      throw new Error(`安装失败且自动恢复失败；请从 ${backup} 手动恢复：${restoreError.message}`, { cause: error });
    }
    throw new Error(`安装失败，已从 ${backup} 恢复原文件：${error.message}`, { cause: error });
  }
  console.log(`已安装 ${sourceManifest.id}@${sourceManifest.version} 到 ${target}；data.json 未改动。`);
  console.log('请在 Obsidian 中重新加载该插件，或重启 Obsidian。');
  return { target, backup, version: sourceManifest.version };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--plugin-dir' || !args[1])) {
    console.error('用法：npm run install:obsidian -- [--plugin-dir "完整插件目录"]');
    process.exitCode = 1;
  } else {
    const destination = args.length ? args[1] : join(homedir(), 'Documents', 'Obsidian Vault', '.obsidian', 'plugins', 'obsidian-ai-rewrite');
    installPlugin(destination).catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
  }
}
