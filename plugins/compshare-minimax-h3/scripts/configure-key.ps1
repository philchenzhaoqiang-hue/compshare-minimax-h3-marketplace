[CmdletBinding()]
param()

$variableName = "COMPSHARE_MINIMAX_API_KEY"
$secureKey = Read-Host "Enter the CompShare model API key (starts with sk-ml-)" -AsSecureString
$keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)

try {
    $plainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer)
    if (-not $plainKey.StartsWith("sk-ml-")) {
        throw "Invalid API key format: the key must start with sk-ml-."
    }

    [Environment]::SetEnvironmentVariable(
        $variableName,
        $plainKey,
        [EnvironmentVariableTarget]::User
    )
    Write-Host "Saved $variableName as a Windows user environment variable."
    Write-Host "Fully quit and reopen Codex, then use the plugin in a new task."
}
finally {
    if ($keyPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
    }
    Remove-Variable plainKey -ErrorAction SilentlyContinue
}
