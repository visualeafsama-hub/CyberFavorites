// 快捷方式和开机自启。Windows 上用 .lnk 快捷方式（开始菜单 / 桌面 / 启动文件夹），
// 不需要管理员权限，也不注册系统服务。其他系统暂不支持，接口返回 supported:false。
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const NAME = 'CyberFavorites';
export const supported = process.platform === 'win32';

function dirs() {
  const appData = process.env.APPDATA ?? '';
  const programs = join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  return {
    startMenu: programs,
    startup: join(programs, 'Startup'),
    desktop: join(process.env.USERPROFILE ?? '', 'Desktop'),
  };
}

const lnk = (where) => join(dirs()[where], `${NAME}.lnk`);

export function status() {
  if (!supported) return { supported: false };
  return {
    supported: true,
    autostart: existsSync(lnk('startup')),
    startMenu: existsSync(lnk('startMenu')),
    desktop: existsSync(lnk('desktop')),
  };
}

// 快捷方式指向 wscript + launch.vbs，由它在后台启动 node，不弹命令行窗口。
// 开机自启那个加 --background：只启动服务，不打开浏览器
async function createLnk(where, { root, icon, background }) {
  mkdirSync(dirs()[where], { recursive: true });
  const wscript = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wscript.exe');
  const args = `"${join(root, 'launch.vbs')}" "${process.execPath}" ${background ? '--background' : '--open'}`;
  // 用 powershell 的 WScript.Shell 建快捷方式；参数通过环境变量传，避免拼进脚本
  const ps = `$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:CF_LNK);
$s.TargetPath=$env:CF_TARGET; $s.Arguments=$env:CF_ARGS; $s.WorkingDirectory=$env:CF_ROOT;
$s.IconLocation=$env:CF_ICON; $s.Description='CyberFavorites 赛博收藏夹'; $s.WindowStyle=7; $s.Save()`;
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    env: { ...process.env, CF_LNK: lnk(where), CF_TARGET: wscript, CF_ARGS: args, CF_ROOT: root, CF_ICON: icon },
    windowsHide: true,
  });
}

export async function set(where, on, opts) {
  if (!supported) throw new Error('目前只支持 Windows');
  if (!['autostart', 'startMenu', 'desktop'].includes(where)) throw new Error(`未知位置 ${where}`);
  const key = where === 'autostart' ? 'startup' : where;
  if (on) await createLnk(key, { ...opts, background: where === 'autostart' });
  else rmSync(lnk(key), { force: true });
  return status();
}
