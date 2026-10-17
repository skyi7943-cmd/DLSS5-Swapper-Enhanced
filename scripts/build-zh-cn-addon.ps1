$ErrorActionPreference = 'Stop'
$appRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$zig = Join-Path $appRoot 'tools/zig-x86_64-windows-0.14.1/zig.exe'
$sdk = Join-Path $appRoot 'tools/reshade-6.8.0'
if (!(Test-Path -LiteralPath $zig) -or !(Test-Path -LiteralPath (Join-Path $sdk 'reshade.hpp'))) {
    throw 'Run npm run overlay:prepare first.'
}

$outputDir = Join-Path $appRoot 'payload/enhanced/zh-cn'
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null

$env:ZIG_GLOBAL_CACHE_DIR = Join-Path $appRoot 'tools/zig-cache'
$env:ZIG_LOCAL_CACHE_DIR = Join-Path $appRoot 'tools/zig-local-cache'

$outFile = Join-Path $outputDir 'dlss5-zh-cn.addon64'
$args = @(
    'c++',
    '-target', 'x86_64-windows-gnu',
    '-std=c++17',
    '-O2',
    '-shared',
    '-static',
    '-fms-extensions',
    '-DWIN32_LEAN_AND_MEAN',
    '-DNOMINMAX',
    '-I', $sdk,
    (Join-Path $appRoot 'overlay/zh-cn-overlay.cpp'),
    '-o', $outFile
)
& $zig @args
if ($LASTEXITCODE -ne 0) {
    throw 'dlss5-zh-cn.addon64 compilation failed.'
}

$stream = [IO.File]::OpenRead($outFile)
$hasher = [Security.Cryptography.SHA256]::Create()
try {
    $hash = [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
} finally {
    $stream.Dispose()
    $hasher.Dispose()
}
Write-Output "Built $outFile (SHA-256 $hash)"
