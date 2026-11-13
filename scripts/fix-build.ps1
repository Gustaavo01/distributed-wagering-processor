
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = (
    Resolve-Path (
        Join-Path $PSScriptRoot '..'
    )
).Path

$utf8 = New-Object System.Text.UTF8Encoding($false)

function Read-Source {
    param([string]$RelativePath)

    $path = Join-Path $projectRoot $RelativePath

    if (-not (Test-Path -LiteralPath $path)) {
        throw "File not found: $RelativePath"
    }

    return [System.IO.File]::ReadAllText($path)
}

function Save-Source {
    param(
        [string]$RelativePath,
        [string]$Original,
        [string]$Updated
    )

    if ($Original -eq $Updated) {
        Write-Host "Already correct: $RelativePath"
        return
    }

    $path = Join-Path $projectRoot $RelativePath

    [System.IO.File]::WriteAllText(
        $path,
        $Updated,
        $utf8
    )

    Write-Host "Corrected: $RelativePath"
}

function Fix-ImportPath {
    param(
        [string]$Content,
        [string]$OldPath,
        [string]$NewPath
    )

    $updated = $Content

    foreach ($quote in @("'", '"')) {
        $oldImport = "from ${quote}${OldPath}${quote}"
        $newImport = "from ${quote}${NewPath}${quote}"

        $updated = $updated.Replace(
            $oldImport,
            $newImport
        )
    }

    return $updated
}

# ======================================
# 1. WALLET LEDGER ENTRY
# ======================================

$file = 'src/domain/entities/wallet-ledger-entry.ts'

$original = Read-Source $file

$updated = Fix-ImportPath `
    -Content $original `
    -OldPath '../value-objects/money' `
    -NewPath '../value-objects/money.js'

Save-Source $file $original $updated

# ======================================
# 2. WALLET
# ======================================

$file = 'src/domain/entities/wallet.ts'

$original = Read-Source $file

$updated = Fix-ImportPath `
    -Content $original `
    -OldPath '../value-objects/money' `
    -NewPath '../value-objects/money.js'

$updated = Fix-ImportPath `
    -Content $updated `
    -OldPath './wallet-ledger-entry' `
    -NewPath './wallet-ledger-entry.js'

Save-Source $file $original $updated

# ======================================
# 3. MONEY / DECIMAL.JS
# ======================================

$file = 'src/domain/value-objects/money.ts'

$original = Read-Source $file

# Aceita import namespace, default e nomeado.
# Reconhece CRLF do Windows e LF.
# Tambem aceita decimal.js/decimal.

$pattern = '(?m)^[ \t]*import[ \t]+[^\r\n]*?[ \t]+from[ \t]+["'']decimal(?:\.js)?(?:/decimal(?:\.js)?)?["''][ \t]*;?[ \t]*(?=\r?$)'

$matches = [regex]::Matches(
    $original,
    $pattern
)

if ($matches.Count -ne 1) {
    Write-Host ""
    Write-Host "Decimal import not recognized."
    Write-Host "Current money.ts first 35 lines:"
    Write-Host ""

    Get-Content (
        Join-Path $projectRoot $file
    ) -TotalCount 35

    throw "Could not safely identify Decimal import."
}

$matchedImport = $matches[0].Value

if ($matchedImport -notmatch '\bDecimal\b') {
    throw "Decimal binding not recognized: $matchedImport"
}

$updated = [regex]::Replace(
    $original,
    $pattern,
    "import { Decimal } from 'decimal.js';"
)

Save-Source $file $original $updated

# ======================================
# 4. WALLET MAPPER
# ======================================

$file = 'src/infrastructure/mappers/wallet.mapper.ts'

$original = Read-Source $file

$updated = Fix-ImportPath `
    -Content $original `
    -OldPath '../persistence/wallet.entity.js' `
    -NewPath '../persistence/entities/wallet.entity.js'

Save-Source $file $original $updated

# ======================================
# FINISH
# ======================================

Write-Host ""
Write-Host "Import corrections completed."
Write-Host "Financial business logic preserved."
Write-Host ""
Write-Host "Run: bun run build"
