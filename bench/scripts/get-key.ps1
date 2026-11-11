# apiKeyHelper for benchmark runs: prints the stored key to stdout (only the key).
# Claude Code runs this inside the child process; the benchmark harness never sees the value.
#   --api-key-helper "powershell -NoProfile -ExecutionPolicy Bypass -File <path>\bench\scripts\get-key.ps1"
$ErrorActionPreference = 'Stop'
[void][Windows.Security.Credentials.PasswordVault, Windows.Security.Credentials, ContentType = WindowsRuntime]
$c = (New-Object Windows.Security.Credentials.PasswordVault).Retrieve('agentic-router-bench', 'anthropic')
$c.RetrievePassword()
[Console]::Out.Write($c.Password)
