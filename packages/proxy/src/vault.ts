// The API key vault (decisions 33, 130): the OS keychain only, reached through the system's own tools so no
// native module runs in the key-holding process. This is the only module that handles the key.
//
//   Windows  Windows PowerShell 5.1 (powershell.exe; pwsh 7 has no WinRT projection): the PasswordVault, as
//            the benchmark's get-key.ps1 does. Where WinRT is not available but the language mode is
//            FullLanguage, a generic Credential Manager entry through CredRead / CredWrite (Add-Type).
//            In ConstrainedLanguage mode (device policy) both WinRT activation and Add-Type are blocked,
//            so no PowerShell route exists there: the vault reports it and API mode stays off.
//   macOS    /usr/bin/security (login keychain, generic password).
//   Linux    secret-tool (libsecret, Secret Service over D-Bus). Without it, API mode stays off.
//
// The key travels only over a pipe: read from the tool's stdout; stored by the tool prompting on the user's
// terminal itself (interactive) or from its stdin. It is never put in argv or in an environment variable.
// Children get a minimal environment.
import { spawn } from 'node:child_process';

export const VAULT_SERVICE = 'agentic-router';
export const VAULT_ACCOUNT = 'anthropic-api-key';

export type VaultErrorCode = 'not_found' | 'unavailable' | 'constrained_language' | 'invalid_key' | 'failed';
export class VaultError extends Error {
  readonly code: VaultErrorCode;
  constructor(code: VaultErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface RunResult { code: number | null; stdout: string; stderr: string }
export interface RunOptions { input?: string; inheritStdio?: boolean; timeoutMs: number }
export type Runner = (command: string, args: string[], o: RunOptions) => Promise<RunResult>;

export interface VaultOptions {
  service?: string;
  account?: string;
  platform?: string;
  run?: Runner;
  env?: NodeJS.ProcessEnv;
}

/** A first keychain access may show an OS dialog the user must answer. */
const READ_TIMEOUT_MS = 60_000;
const ENV_KEEP = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'TEMP', 'TMP', 'HOME', 'USERPROFILE',
  'USER', 'LOGNAME', 'USERNAME', 'LANG', 'LC_ALL', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'DISPLAY', 'WAYLAND_DISPLAY'];

export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of ENV_KEEP) if (env[k] !== undefined) out[k] = env[k];
  return out;
}

const NAME = /^[A-Za-z0-9._-]{1,64}$/;

/** Checks a key's shape (never its value against anything): one printable token. */
export function validKey(key: string): boolean {
  return key.length >= 8 && key.length <= 512 && /^[\x21-\x7e]+$/.test(key);
}

function defaultRunner(env: NodeJS.ProcessEnv): Runner {
  return (command, args, o) => new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(command, args, {
        env, windowsHide: true, shell: false,
        stdio: o.inheritStdio ? 'inherit' : ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: String(e) });
      return;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, o.timeoutMs);
    child.stdout?.setEncoding('utf8').on('data', (c: string) => { stdout += c; });
    child.stderr?.setEncoding('utf8').on('data', (c: string) => { stderr += c; });
    child.on('error', e => { clearTimeout(timer); resolve({ code: null, stdout, stderr: `${stderr}${String(e)}` }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    if (child.stdin) {
      child.stdin.on('error', () => { /* the tool may not read stdin */ });
      child.stdin.end(o.input ?? '');
    }
  });
}

// ------------------------------------------------------------------ Windows (PowerShell 5.1)

const ps = (s: string) => s.replace(/'/g, "''");

/** The CredRead / CredWrite declarations (Add-Type), used where WinRT's PasswordVault is unavailable. */
const CRED_TYPE = `
Add-Type -Namespace AgenticRouter -Name Cred -MemberDefinition @'
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential, CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
public struct CREDENTIAL {
  public int Flags; public int Type; public string TargetName; public string Comment; public long LastWritten;
  public int CredentialBlobSize; public System.IntPtr CredentialBlob; public int Persist; public int AttributeCount;
  public System.IntPtr Attributes; public string TargetAlias; public string UserName;
}
[System.Runtime.InteropServices.DllImport("advapi32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true)]
public static extern bool CredRead(string target, int type, int flags, out System.IntPtr cred);
[System.Runtime.InteropServices.DllImport("advapi32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true)]
public static extern bool CredWrite(ref CREDENTIAL cred, int flags);
[System.Runtime.InteropServices.DllImport("advapi32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true)]
public static extern bool CredDelete(string target, int type, int flags);
[System.Runtime.InteropServices.DllImport("advapi32.dll")]
public static extern void CredFree(System.IntPtr cred);
'@`;

function winPrelude(service: string, account: string): string {
  return `$ErrorActionPreference = 'Stop'
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { [Console]::Error.Write('AR_VAULT_CONSTRAINED'); exit 3 }
$svc = '${ps(service)}'; $acct = '${ps(account)}'; $target = "$svc/$acct"
$vault = $null
try {
  [void][Windows.Security.Credentials.PasswordVault, Windows.Security.Credentials, ContentType = WindowsRuntime]
  $vault = New-Object Windows.Security.Credentials.PasswordVault
} catch { $vault = $null }
`;
}

export function windowsReadScript(service: string, account: string): string {
  return `${winPrelude(service, account)}
if ($vault) {
  try { $c = $vault.Retrieve($svc, $acct) } catch { $c = $null }
  if ($c) { $c.RetrievePassword(); [Console]::Out.Write($c.Password); exit 0 }
}
${CRED_TYPE}
$p = [IntPtr]::Zero
if ([AgenticRouter.Cred]::CredRead($target, 1, 0, [ref]$p)) {
  $c = [System.Runtime.InteropServices.Marshal]::PtrToStructure($p, [type][AgenticRouter.Cred+CREDENTIAL])
  $s = [System.Runtime.InteropServices.Marshal]::PtrToStringUni($c.CredentialBlob, [int]($c.CredentialBlobSize / 2))
  [AgenticRouter.Cred]::CredFree($p)
  [Console]::Out.Write($s); exit 0
}
[Console]::Error.Write('AR_VAULT_NOT_FOUND'); exit 2
`;
}

/** interactive: Read-Host on the user's console; otherwise the key comes on stdin. */
export function windowsStoreScript(service: string, account: string, interactive: boolean): string {
  const read = interactive
    ? `$sec = Read-Host -AsSecureString -Prompt 'Anthropic API key'
$b = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
try { $key = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }`
    : '$key = [Console]::In.ReadToEnd().Trim()';
  return `${winPrelude(service, account)}
${read}
if (-not $key) { [Console]::Error.Write('AR_VAULT_EMPTY'); exit 4 }
if ($vault) {
  try { $vault.Remove($vault.Retrieve($svc, $acct)) } catch { }
  $vault.Add((New-Object Windows.Security.Credentials.PasswordCredential($svc, $acct, $key))); exit 0
}
${CRED_TYPE}
$bytes = [System.Text.Encoding]::Unicode.GetBytes($key)
$blob = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
[System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $blob, $bytes.Length)
$c = New-Object AgenticRouter.Cred+CREDENTIAL
$c.Type = 1; $c.TargetName = $target; $c.UserName = $acct; $c.CredentialBlobSize = $bytes.Length; $c.CredentialBlob = $blob; $c.Persist = 2
$ok = [AgenticRouter.Cred]::CredWrite([ref]$c, 0)
[System.Runtime.InteropServices.Marshal]::FreeHGlobal($blob)
if ($ok) { exit 0 } else { exit 5 }
`;
}

export function windowsDeleteScript(service: string, account: string): string {
  return `${winPrelude(service, account)}
if ($vault) { try { $vault.Remove($vault.Retrieve($svc, $acct)) } catch { } }
${CRED_TYPE}
[void][AgenticRouter.Cred]::CredDelete($target, 1, 0)
exit 0
`;
}

/** powershell.exe with the script as -EncodedCommand (UTF-16LE base64): no quoting, and no secret in it. */
export function powershellArgs(script: string, interactive = false): string[] {
  return ['-NoProfile', ...(interactive ? [] : ['-NonInteractive']), '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}

// ------------------------------------------------------------------ commands per platform

interface Plan { command: string; args: string[] }

export function readPlan(platform: string, service: string, account: string): Plan {
  if (platform === 'win32') return { command: 'powershell.exe', args: powershellArgs(windowsReadScript(service, account)) };
  if (platform === 'darwin') return { command: '/usr/bin/security', args: ['find-generic-password', '-s', service, '-a', account, '-w'] };
  return { command: 'secret-tool', args: ['lookup', 'service', service, 'account', account] };
}

/** Store: interactive (the tool prompts on the inherited terminal) or from stdin (Windows, Linux). */
export function storePlan(platform: string, service: string, account: string, interactive: boolean): Plan {
  if (platform === 'win32') return { command: 'powershell.exe', args: powershellArgs(windowsStoreScript(service, account, interactive), interactive) };
  if (platform === 'darwin') {
    // -w last with no value: security prompts for the password itself (never in argv)
    return { command: '/usr/bin/security', args: ['add-generic-password', '-U', '-s', service, '-a', account, '-l', 'Agentic Router API key', '-w'] };
  }
  return { command: 'secret-tool', args: ['store', '--label=Agentic Router API key', 'service', service, 'account', account] };
}

export function deletePlan(platform: string, service: string, account: string): Plan {
  if (platform === 'win32') return { command: 'powershell.exe', args: powershellArgs(windowsDeleteScript(service, account)) };
  if (platform === 'darwin') return { command: '/usr/bin/security', args: ['delete-generic-password', '-s', service, '-a', account] };
  return { command: 'secret-tool', args: ['clear', 'service', service, 'account', account] };
}

function names(o: VaultOptions): { service: string; account: string; platform: string; run: Runner } {
  const service = o.service ?? VAULT_SERVICE;
  const account = o.account ?? VAULT_ACCOUNT;
  if (!NAME.test(service) || !NAME.test(account)) throw new VaultError('failed', 'vault service and account names are letters, digits, ".", "_" and "-"');
  return { service, account, platform: o.platform ?? process.platform, run: o.run ?? defaultRunner(childEnv(o.env)) };
}

function failure(platform: string, r: RunResult, what: string): VaultError {
  if (r.code === null && /ENOENT|not found|cannot find/i.test(r.stderr)) {
    const tool = platform === 'win32' ? 'Windows PowerShell (powershell.exe)' : platform === 'darwin' ? '/usr/bin/security' : 'secret-tool (libsecret-tools)';
    return new VaultError('unavailable', `the OS keychain tool is not available: ${tool}`);
  }
  if (/AR_VAULT_CONSTRAINED/.test(r.stderr)) {
    return new VaultError('constrained_language', 'PowerShell runs in ConstrainedLanguage mode (device policy), which blocks both the PasswordVault and Credential Manager access: API-key mode is unavailable on this machine');
  }
  if (/AR_VAULT_NOT_FOUND/.test(r.stderr) || (platform === 'darwin' && r.code === 44) || (platform !== 'win32' && platform !== 'darwin' && r.code === 1 && !r.stdout)) {
    return new VaultError('not_found', 'no API key in the OS keychain (run agentic-router key set)');
  }
  return new VaultError('failed', `${what} failed (exit ${r.code ?? 'none'})`);
}

/** The API key from the OS keychain. Throws VaultError. */
export async function readKey(o: VaultOptions = {}): Promise<string> {
  const { service, account, platform, run } = names(o);
  const plan = readPlan(platform, service, account);
  const r = await run(plan.command, plan.args, { timeoutMs: READ_TIMEOUT_MS });
  if (r.code !== 0) throw failure(platform, r, 'reading the keychain');
  const key = r.stdout.replace(/^﻿/, '').trim();
  if (!validKey(key)) throw new VaultError('invalid_key', 'the keychain entry is not a valid key (empty, too long or with spaces)');
  return key;
}

/**
 * Stores the key. interactive: the keychain tool prompts on the user's terminal and the key never passes
 * through this process. Otherwise `key` goes to the tool's stdin (Windows, Linux; macOS needs interactive).
 */
export async function storeKey(o: VaultOptions & { interactive: true } | VaultOptions & { interactive: false; key: string }): Promise<void> {
  const { service, account, platform, run } = names(o);
  if (!o.interactive) {
    if (platform === 'darwin') throw new VaultError('failed', 'on macOS the key is stored interactively (security prompts for it)');
    if (!validKey(o.key)) throw new VaultError('invalid_key', 'not a valid key (empty, too long or with spaces)');
  }
  const plan = storePlan(platform, service, account, o.interactive);
  const r = await run(plan.command, plan.args, o.interactive ? { inheritStdio: true, timeoutMs: 10 * 60_000 } : { input: o.key, timeoutMs: READ_TIMEOUT_MS });
  if (r.code !== 0) throw failure(platform, r, 'storing the key');
}

export async function deleteKey(o: VaultOptions = {}): Promise<void> {
  const { service, account, platform, run } = names(o);
  const plan = deletePlan(platform, service, account);
  const r = await run(plan.command, plan.args, { timeoutMs: READ_TIMEOUT_MS });
  if (r.code !== 0 && !(platform === 'darwin' && r.code === 44)) throw failure(platform, r, 'deleting the key');
}

/**
 * The key held by the running proxy. The value lives in this closure only; callers get a function that
 * returns it for the one place that sets the upstream header.
 */
export async function loadKey(o: VaultOptions = {}): Promise<{ get: () => string; masked: string }> {
  const key = await readKey(o);
  return { get: () => key, masked: `${key.slice(0, 7)}…${key.slice(-4)}` };
}
