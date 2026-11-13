
param(
    [switch]$KeepEnvironment
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# ==========================================
# CONFIGURATION
# ==========================================

$projectRoot = (
    Resolve-Path (
        Join-Path $PSScriptRoot '..'
    )
).Path

$composeFile = Join-Path $projectRoot 'docker-compose.verify.yml'

$composeArgs = @(
    'compose',
    '-p',
    'wagering-verify',
    '-f',
    $composeFile
)

$environmentNames = @(
    'DB_HOST',
    'DB_PORT',
    'DB_USER',
    'DB_PASSWORD',
    'DB_NAME',
    'AWS_REGION',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'SQS_ENDPOINT',
    'PENDING_REFERENCE_WORKER_ENABLED',
    'OUTBOX_PUBLISHER_ENABLED',
    'WAGER_SQS_CONSUMER_ENABLED'
)

$originalEnvironment = @{}

foreach ($name in $environmentNames) {
    $originalEnvironment[$name] =
        [Environment]::GetEnvironmentVariable(
            $name,
            'Process'
        )
}

$success = $false

# ==========================================
# COMMAND EXECUTION
# ==========================================

function Invoke-Checked {
    param(
        [string]$Executable,
        [string[]]$Arguments
    )

    & $Executable @Arguments

    $exitCode = $LASTEXITCODE

    if ($exitCode -ne 0) {
        throw "$Executable failed with exit code $exitCode"
    }
}

function Write-Step {
    param(
        [string]$Message
    )

    Write-Host ""
    Write-Host "========================================"
    Write-Host $Message
    Write-Host "========================================"
}

Push-Location $projectRoot

try {
    # ======================================
    # ISOLATED ENVIRONMENT
    # ======================================

    $env:DB_HOST = '127.0.0.1'
    $env:DB_PORT = '5543'
    $env:DB_USER = 'wagering_user'
    $env:DB_PASSWORD = 'wagering_verify_only'
    $env:DB_NAME = 'wagering_db'

    $env:AWS_REGION = 'us-east-1'
    $env:AWS_ACCESS_KEY_ID = 'test'
    $env:AWS_SECRET_ACCESS_KEY = 'test'

    $env:SQS_ENDPOINT = 'http://127.0.0.1:5566'

    $env:PENDING_REFERENCE_WORKER_ENABLED = 'false'
    $env:OUTBOX_PUBLISHER_ENABLED = 'false'
    $env:WAGER_SQS_CONSUMER_ENABLED = 'false'

    # ======================================
    # DEPENDENCIES
    # ======================================

    Write-Step "1. Installing locked dependencies"

    Invoke-Checked 'bun' @(
        'install',
        '--frozen-lockfile'
    )

    # ======================================
    # CLEAN TEST INFRASTRUCTURE
    # ======================================

    Write-Step "2. Removing ONLY isolated verification data"

    Write-Host "Docker project: wagering-verify"
    Write-Host "Existing development containers are untouched."

    Invoke-Checked 'docker' (
        $composeArgs + @(
            'down',
            '--volumes',
            '--remove-orphans'
        )
    )

    Write-Step "3. Starting fresh PostgreSQL and MiniStack"

    Invoke-Checked 'docker' (
        $composeArgs + @(
            'up',
            '-d',
            '--wait',
            '--wait-timeout',
            '120'
        )
    )

    Invoke-Checked 'docker' (
        $composeArgs + @('ps')
    )

    # ======================================
    # DATABASE MIGRATIONS
    # ======================================

    Write-Step "4. Applying migrations to fresh database"

    Invoke-Checked 'bun' @(
        'run',
        'scripts/migrate.ts'
    )

    # ======================================
    # SQS QUEUES
    # ======================================

    Write-Step "5. Creating isolated SQS queues"

    $queuesReady = $false

    for ($attempt = 1; $attempt -le 5; $attempt++) {
        try {
            Invoke-Checked 'bun' @(
                'run',
                'scripts/setup-sqs.ts'
            )

            $queuesReady = $true
            break
        }
        catch {
            if ($attempt -eq 5) {
                throw
            }

            Write-Host "SQS not ready; retrying setup..."
            Start-Sleep -Seconds 2
        }
    }

    if (-not $queuesReady) {
        throw "SQS queue setup did not complete"
    }

    # ======================================
    # TYPESCRIPT BUILD
    # ======================================

    Write-Step "6. Building NestJS application"

    Invoke-Checked 'bun' @(
        'run',
        'build'
    )

    # ======================================
    # FULL TEST SUITE
    # ======================================

    Write-Step "7. Running all tests on fresh infrastructure"

    Invoke-Checked 'bun' @(
        'test',
        './test'
    )

    # ======================================
    # SUCCESS
    # ======================================

    $success = $true

    Write-Step "VALIDATION SUCCESSFUL"

    Write-Host "Dependencies: OK"
    Write-Host "Fresh PostgreSQL: OK"
    Write-Host "Database migrations: OK"
    Write-Host "SQS queues: OK"
    Write-Host "TypeScript build: OK"
    Write-Host "Test suite: OK"
}
catch {
    Write-Host ""
    Write-Host "VALIDATION FAILED"
    Write-Host $_.Exception.Message

    Write-Host ""
    Write-Host "The isolated containers were preserved"
    Write-Host "for investigation."

    throw
}
finally {
    # ======================================
    # CLEANUP
    # ======================================

    if ($success -and -not $KeepEnvironment) {
        Write-Step "Removing isolated test infrastructure"

        try {
            Invoke-Checked 'docker' (
                $composeArgs + @(
                    'down',
                    '--volumes',
                    '--remove-orphans'
                )
            )
        }
        catch {
            Write-Warning "Isolated Docker cleanup failed"
        }
    }

    if ($KeepEnvironment) {
        Write-Host ""
        Write-Host "Verification environment was preserved."
        Write-Host "PostgreSQL port: 5543"
        Write-Host "MiniStack port: 5566"
    }

    # Restore previous environment variables.
    foreach ($name in $environmentNames) {
        [Environment]::SetEnvironmentVariable(
            $name,
            $originalEnvironment[$name],
            'Process'
        )
    }

    Pop-Location
}
