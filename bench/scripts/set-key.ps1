# Stores the Anthropic API key for benchmark runs in the Windows Credential Locker (PasswordVault).
# The key is read with a masked prompt: it is never echoed, passed on a command line, or written
# to PowerShell history or any file.
#   powershell -NoProfile -ExecutionPolicy Bypass -File bench\scripts\set-key.ps1
$ErrorActionPreference = 'Stop'
[void][Windows.Security.Credentials.PasswordVault, Windows.Security.Credentials, ContentType = WindowsRuntime]
$secure = Read-Host -AsSecureString 'Anthropic API key (input hidden)'
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  if ($plain -notmatch '^sk-ant-') { throw 'This does not look like an Anthropic API key (expected sk-ant-...).' }
  $vault = New-Object Windows.Security.Credentials.PasswordVault
  try { $vault.Remove($vault.Retrieve('agentic-router-bench', 'anthropic')) } catch { }
  $vault.Add((New-Object Windows.Security.Credentials.PasswordCredential('agentic-router-bench', 'anthropic', $plain)))
  Write-Host 'Stored in Windows Credential Locker as resource "agentic-router-bench".'
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  Remove-Variable plain -ErrorAction SilentlyContinue
}
