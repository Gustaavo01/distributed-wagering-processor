
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# ======================================
# SETTINGS
# ======================================

$root = (
    Resolve-Path (
        Join-Path $PSScriptRoot '..'
    )
).Path

Set-Location $root

$imageName = 'wagering-sigterm-check:local'

$containerName = 'wagering-sigterm-' +
    [guid]::NewGuid().ToString('N').Substring(0, 8)

$envFile = Join-Path $root '.env'

$containerStarted = $false

# ======================================
# HELPERS
# ======================================

function Assert-LastExitCode {
    param([string]$Operation)

    if ($LASTEXITCODE -ne 0) {
        throw "$Operation failed with exit code $LASTEXITCODE"
    }
}

function Write-Section {
    param([string]$Message)

    Write-Host ""
    Write-Host ('=' * 55)
    Write-Host $Message
    Write-Host ('=' * 55)
}

# ======================================
# PRECHECK
# ======================================

if (-not (Test-Path -LiteralPath $envFile)) {
    throw 'Local .env file not found.'
}

if (-not (
    Test-Path -LiteralPath '.\Dockerfile.sigterm'
)) {
    throw 'Dockerfile.sigterm not found.'
}

if (-not (
    Test-Path -LiteralPath '.\.dockerignore'
)) {
    throw '.dockerignore not found.'
}

try {
    # ==================================
    # BUILD LINUX IMAGE
    # ==================================

    Write-Section '1. Building Linux container'

    & docker build `
        --file Dockerfile.sigterm `
        --tag $imageName `
        .

    Assert-LastExitCode 'Docker build'

    # ==================================
    # START CONTAINER
    # ==================================

    Write-Section '2. Starting application'

    # As portas 5433 e 4566 devem estar
    # disponiveis no host, de acordo
    # com a infraestrutura local.
    #
    # Usamos o .env existente, mas
    # alteramos os enderecos para que
    # o container Linux alcance o host.
    #
    # A porta HTTP externa e escolhida
    # automaticamente pelo Docker.

    & docker run `
        --detach `
        --name $containerName `
        --env-file $envFile `
        --add-host 'host.docker.internal:host-gateway' `
        --env 'DB_HOST=host.docker.internal' `
        --env 'SQS_ENDPOINT=http://host.docker.internal:4566' `
        --env 'PORT=3000' `
        --publish '127.0.0.1::3000' `
        $imageName

    Assert-LastExitCode 'Docker run'

    $containerStarted = $true

    # ==================================
    # DISCOVER HTTP PORT
    # ==================================

    Write-Section '3. Discovering HTTP port'

    $portOutput = (
        & docker port $containerName '3000/tcp'
    ) | Select-Object -First 1

    Assert-LastExitCode 'Docker port'

    if (
        -not $portOutput -or
        $portOutput -notmatch ':(\d+)\s*$'
    ) {
        throw 'Could not identify container HTTP port.'
    }

    $hostPort = $Matches[1]

    $healthUrl = "http://127.0.0.1:$hostPort/health/ready"

    Write-Host "Health endpoint: $healthUrl"

    # ==================================
    # WAIT FOR READINESS
    # ==================================

    Write-Section '4. Checking readiness'

    $ready = $false

    for ($attempt = 1; $attempt -le 30; $attempt++) {
        try {
            $response = Invoke-WebRequest `
                -Uri $healthUrl `
                -UseBasicParsing `
                -TimeoutSec 2 `
                -ErrorAction Stop

            if ($response.StatusCode -eq 200) {
                $ready = $true
                break
            }
        }
        catch {
            # A aplicacao pode ainda
            # estar iniciando.
        }

        Start-Sleep -Seconds 1
    }

    if (-not $ready) {
        Write-Host 'Application did not become ready.'

        & docker logs $containerName

        throw 'Readiness verification failed.'
    }

    Write-Host 'Application ready: OK'

    # ==================================
    # SEND REAL SIGTERM
    # ==================================

    Write-Section '5. Sending SIGTERM'

    # Docker stop envia SIGTERM e
    # concede ate 30 segundos para
    # a aplicacao encerrar.
    #
    # Se nao terminar, Docker podera
    # finalizar com SIGKILL.

    & docker stop `
        --time 30 `
        $containerName

    Assert-LastExitCode 'Docker stop'

    # ==================================
    # INSPECT EXIT AND LOGS
    # ==================================

    Write-Section '6. Checking shutdown logs'

    $logs = (
        & docker logs $containerName 2>&1 |
            Out-String
    )

    Write-Host $logs

    $exitCodeText = (
        & docker inspect `
            --format '{{.State.ExitCode}}' `
            $containerName
    )

    Assert-LastExitCode 'Docker inspect'

    $exitCode = [int]$exitCodeText

    if ($exitCode -eq 137) {
        throw 'Container was killed before graceful shutdown.'
    }

    if (
        $logs -notmatch 'sqs_shutdown_completed'
    ) {
        throw 'SQS shutdown completion log not found.'
    }

    if (
        $logs -notmatch 'releaseFailures["\s:]+0'
    ) {
        throw 'SQS shutdown may have release failures.'
    }

    # ==================================
    # SUCCESS
    # ==================================

    Write-Section 'SIGTERM VERIFICATION SUCCESSFUL'

    Write-Host 'Linux container: OK'
    Write-Host 'Application readiness: OK'
    Write-Host 'SIGTERM delivered: OK'
    Write-Host 'SQS shutdown hook: OK'
    Write-Host 'SQS release failures: 0'
    Write-Host "Container exit code: $exitCode"
}
finally {
    # ==================================
    # CLEANUP
    # ==================================

    if ($containerStarted) {
        Write-Section 'Removing temporary container'

        & docker rm --force $containerName 2>&1 |
            Out-Null
    }
}
