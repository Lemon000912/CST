# 使用项目内 .venv-mineru 调用 MinerU 解析 PDF（或目录下 PDF）
# 用法（在「论文查询」项目根目录）:
#   .\scripts\mineru_scan.ps1 -Pdf "D:\papers\某篇.pdf"
#   .\scripts\mineru_scan.ps1 -Pdf "D:\papers\" -Out "D:\papers\mineru_md" -Backend pipeline -Lang ch

param(
    [Parameter(Mandatory = $true)]
    [string] $Pdf,
    [string] $Out = "",
    [ValidateSet("pipeline", "hybrid-auto-engine", "vlm-auto-engine", "hybrid-http-client", "vlm-http-client")]
    [string] $Backend = "pipeline",
    [string] $Lang = "ch"
)

$Root = Split-Path $PSScriptRoot -Parent
if (-not (Test-Path "$Root\.venv-mineru\Scripts\mineru.exe")) {
    Write-Error "未找到 $Root\.venv-mineru\Scripts\mineru.exe，请先在项目根目录创建虚拟环境并执行: pip install -U mineru"
    exit 1
}

if ([string]::IsNullOrWhiteSpace($Out)) {
    $Out = Join-Path (Split-Path $Pdf -Parent) "mineru_out"
}

New-Item -ItemType Directory -Force -Path $Out | Out-Null

$exe = Join-Path $Root ".venv-mineru\Scripts\mineru.exe"
Write-Host "MinerU: $exe"
Write-Host "输入: $Pdf"
Write-Host "输出: $Out"
Write-Host "后端: $Backend  语言: $Lang"
& $exe -p $Pdf -o $Out -b $Backend -l $Lang
