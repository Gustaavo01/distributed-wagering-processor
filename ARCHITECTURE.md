
# Arquitetura — Distributed Wagering Processor

**Desafio técnico Back-end — Jungle Gaming**

Este documento descreve as decisões arquiteturais, as invariantes financeiras, a estratégia de concorrência distribuída, o processamento assíncrono, a recuperação após falhas, os trade-offs e as limitações conhecidas da implementação.

## 1. Objetivos arquiteturais

O principal objetivo do sistema é garantir a integridade de operações financeiras mesmo em cenários de concorrência e falhas distribuídas.

A arquitetura considera:

- Requisições simultâneas para a mesma carteira;
- Operações concorrentes em carteiras distintas;
- Múltiplos processos independentes;
- Mensagens duplicadas;
- Entregas fora de ordem;
- Falhas antes e depois do commit;
- Indisponibilidade transitória do SQS;
- Perda de confirmação de publicação;
- Reentrega após reinicialização;
- Encerramento de workers.

As propriedades fundamentais são:

1. Nenhuma operação pode produzir saldo negativo.
2. Uma identidade financeira não pode gerar movimentos duplicados.
3. Cada alteração de saldo deve ter um lançamento financeiro correspondente.
4. O ledger deve permanecer imutável.
5. Uma operação financeira não pode confirmar apenas parte de suas alterações.
6. Eventos confirmados no banco devem continuar disponíveis para publicação.
7. Mensagens reentregues devem ser processadas de maneira idempotente.

A implementação prioriza consistência e auditabilidade antes de otimizações de throughput.

## 2. Estilo arquitetural

A solução utiliza um monólito modular com responsabilidades separadas entre domínio, aplicação, infraestrutura e apresentação.

```text
                 +----------------------+
                 | Presentation         |
                 | HTTP / Controllers   |
                 +----------+-----------+
                            |
                            v
                 +----------------------+
                 | Application          |
                 | Use Cases / Queries  |
                 +----------+-----------+
                            |
                            v
                 +----------------------+
                 | Domain               |
                 | Money / Wallet       |
                 | WagerTransaction     |
                 +----------------------+

                 +----------------------+
                 | Infrastructure       |
                 | PostgreSQL / SQS     |
                 | Inbox / Outbox       |
                 | Workers              |
                 +----------------------+
```

### Domain

Contém as regras financeiras independentes de transporte e persistência.

Componentes principais:

- `Money`;
- `Wallet`;
- `WalletLedgerEntry`;
- `WagerTransaction`;
- Eventos de integração.

### Application

Contém os casos de uso:

- `CreateWalletUseCase`;
- `ProcessWagerTransactionUseCase`.

E as consultas:

- `FinancialQueryService`.

A aplicação coordena o fluxo entre o domínio e a infraestrutura transacional.

### Infrastructure

Contém as integrações:

- PostgreSQL e MikroORM;
- Entidades de persistência e mappers;
- AWS SQS;
- Transactional Inbox;
- Transactional Outbox;
- Workers;
- Métricas e logs.

### Presentation

Contém:

- Controllers HTTP;
- DTOs;
- ValidationPipe;
- Filtro global de exceções;
- Interceptors de correlação e métricas.

### Por que um monólito modular?

O desafio exige comportamento distribuído, mas não exige a separação física do domínio em vários microserviços.

O monólito modular reduz:

- Complexidade de implantação;
- Acoplamento entre serviços;
- Necessidade de comunicação síncrona interna;
- Sobrecarga operacional;
- Superfície de falhas.

Ao mesmo tempo, permite que múltiplas instâncias compartilhem o PostgreSQL e o SQS.

Assim, a correção financeira permanece distribuída sem depender de um processo único.

## 3. Modelo de domínio

### 3.1. Money

`Money` é um Value Object utilizado para representar valores monetários.

Contrato:

```json
{
  "amount": "25.00",
  "currency": "BRL"
}
```

A implementação utiliza Decimal.js para operações aritméticas.

Isso evita erros de precisão associados a números de ponto flutuante.

#### Invariantes

- Representação decimal válida;
- Escala monetária de duas casas;
- Moeda em formato válido;
- Operações somente entre moedas compatíveis;
- Imutabilidade;
- Controle dos limites da persistência.

A persistência utiliza `NUMERIC` no PostgreSQL.

#### Trade-off

Decimal.js adiciona uma dependência, mas centraliza a aritmética financeira e evita o uso de `number` para cálculos de dinheiro.

### 3.2. Wallet

`Wallet` é o Aggregate Root responsável pelo saldo.

A carteira contém:

- Identificador;
- Jogador;
- Moeda;
- Saldo;
- Versão;
- Datas de criação e atualização.

#### Invariantes

1. O saldo nunca pode ser negativo.
2. A movimentação deve utilizar a moeda da carteira.
3. Crédito e débito devem gerar lançamentos financeiros.
4. A carteira deve possuir versão consistente.
5. Um jogador não pode possuir carteiras duplicadas na mesma moeda.

O domínio define as regras de movimentação, enquanto a infraestrutura garante sua aplicação sob concorrência.

### 3.3. WagerTransaction

Representa uma operação financeira de aposta.

Tipos:

```text
OPENING
BET
WIN
LOSS
REFUND
ROLLBACK
```

Estados:

```text
PENDING
PENDING_REFERENCE
PROCESSED
REJECTED
FAILED
```

`OPENING` é uma operação interna, utilizada durante a abertura de carteira com saldo positivo.

As demais operações são recebidas por API ou SQS.

#### Regras de estado

A transação começa em `PENDING`.

Operações dependentes de referências ausentes podem assumir `PENDING_REFERENCE`.

Os estados `PROCESSED`, `REJECTED` e `FAILED` são terminais.

O domínio impede a reabertura indevida de transações terminais.

#### Identidade financeira

Cada transação possui:

- ID interno;
- `providerId`;
- `externalTransactionId`;
- `idempotencyKey`;
- `payloadHash`.

Esses campos permitem identificar operações mesmo após reinicialização ou reentrega.

### 3.4. WalletLedgerEntry

O ledger representa o histórico financeiro imutável.

Cada lançamento registra:

- Identificador;
- Carteira;
- Transação;
- Direção;
- Valor;
- Moeda;
- Saldo anterior;
- Saldo posterior;
- Data.

Direções:

```text
DEBIT
CREDIT
```

Para débito:

```text
balanceAfter = balanceBefore - amount
```

Para crédito:

```text
balanceAfter = balanceBefore + amount
```

Os lançamentos são append-only.

O banco impede alterações e exclusões por meio de trigger.

## 4. Regras das operações financeiras

| Operação | Efeito | Requisitos |
|---|---|---|
| OPENING | Crédito inicial | Uso exclusivamente interno |
| BET | Débito | Saldo suficiente |
| WIN | Crédito | Operação válida |
| LOSS | Sem movimento | Registro do resultado |
| REFUND | Crédito | Reverter BET válida integralmente |
| ROLLBACK | Efeito inverso | Referência válida e saldo suficiente quando aplicável |

### BET

Uma BET utiliza o saldo disponível.

Se o saldo for insuficiente, a operação é rejeitada sem movimentação.

### WIN

Uma WIN credita o valor da operação.

### LOSS

LOSS não altera o saldo nem cria lançamento financeiro.

### REFUND

REFUND reverte uma BET processada.

A implementação valida:

- Identidade do provedor;
- Jogador e carteira;
- Moeda e rodada;
- Tipo e estado da referência;
- Valor integral;
- Ausência de reversão incompatível ou duplicada.

Reembolso parcial não faz parte do escopo.

### ROLLBACK

ROLLBACK desfaz o efeito de uma operação referenciada.

Exemplos:

```text
BET       -> ROLLBACK gera CREDIT
WIN       -> ROLLBACK gera DEBIT
REFUND    -> ROLLBACK gera DEBIT
```

A reversão nunca pode produzir saldo negativo.

### Erros de domínio

Erros de validação financeira são representados por exceções específicas do domínio.

Isso permite diferenciar:

- Payload inválido;
- Violação de regra de negócio;
- Identidade conflitante;
- Recurso inexistente;
- Falha interna.

Os contratos HTTP utilizam essa classificação para responder com códigos apropriados.

## 5. Persistência

O PostgreSQL 17 é a fonte de verdade para o estado financeiro.

Tabelas principais:

```text
wallets
wager_transactions
wallet_ledger_entries
inbox_messages
outbox_messages
```

A persistência utiliza MikroORM 7, com EntityManager e transações explícitas.

O domínio permanece separado das entidades de banco através dos mappers.

### 5.1. Wallets

Restrições principais:

```text
PRIMARY KEY (id)
UNIQUE (player_id, currency)
CHECK (balance >= 0)
CHECK (version >= 1)
```

Também existe validação para o formato de moeda.

### 5.2. Wager Transactions

Restrições principais:

```text
PRIMARY KEY (id)
UNIQUE (provider_id, external_transaction_id)
UNIQUE (idempotency_key)
```

Outras regras verificam:

- Tipo e status;
- Moeda;
- Valores monetários;
- Hash do payload;
- Referências obrigatórias;
- Tentativas de resolução;
- Saldo resultante;
- Reversões processadas únicas.

### 5.3. Ledger

Restrições principais:

```text
PRIMARY KEY (id)
UNIQUE (transaction_id)
CHECK (amount > 0)
CHECK (balance_before >= 0)
CHECK (balance_after >= 0)
```

Foreign Keys vinculam os lançamentos às carteiras e transações.

Checks adicionais verificam a consistência aritmética.

#### Imutabilidade

O banco possui:

```text
ledger_immutable_trigger
```

Utilizando a função:

```text
reject_ledger_mutation()
```

O trigger impede `UPDATE` e `DELETE`.

A imutabilidade foi comprovada em testes SQL diretos.

### 5.4. Inbox

Utiliza a identidade:

```text
PRIMARY KEY (consumer_name, message_id)
```

Também possui validação para o hash de payload persistido.

### 5.5. Outbox

Armazena:

- ID do evento;
- Tipo de evento;
- Aggregate ID;
- Payload JSON;
- Data de ocorrência;
- Tentativas;
- Próxima tentativa;
- Data de publicação.

Possui índices para localizar eventos pendentes e coordenar a publicação.

### Auditoria do schema

A auditoria realizada identificou:

```text
32 constraints
14 índices
1 trigger personalizado
```

Esses controles foram acompanhados por testes de integridade financeira.

## 6. Concorrência distribuída

A carteira é a unidade principal de serialização financeira.

A implementação utiliza:

- Advisory locks transacionais para identidades idempotentes;
- Ordenação estável dos locks de identidade;
- Lock pessimista na carteira;
- Constraints de unicidade;
- Transação SQL para alteração do estado.

### Fluxo conceitual

```text
Receber operação
       |
       v
Validar entrada
       |
       v
Iniciar transação PostgreSQL
       |
       v
Adquirir locks de identidade
       |
       v
Bloquear carteira
       |
       v
Consultar idempotência
       |
       v
Aplicar regras financeiras
       |
       v
Persistir transação + wallet
+ ledger + inbox/outbox
       |
       v
COMMIT
       |
       v
Responder HTTP / ACK SQS
```

### Mesmo saldo, duas apostas

Saldo inicial:

```text
100.00 BRL
```

Duas BETs simultâneas:

```text
BET A: 80.00 BRL
BET B: 80.00 BRL
```

Resultado validado:

```text
1 PROCESSED
1 REJECTED

Saldo final: 20.00 BRL
Débitos no ledger: 1
```

Não existe garantia sobre qual aposta vence a disputa.

Existe garantia sobre o resultado financeiro final.

### Múltiplos processos

Os testes utilizaram três processos Bun independentes compartilhando PostgreSQL.

Foram exercitados:

- Concorrência sobre saldo;
- Cinquenta solicitações idênticas;
- Recuperação após falha simulada depois do commit.

### Carteiras independentes

Um novo teste de integração segura um lock pessimista na carteira A e envia uma operação para a carteira B.

A operação B precisa concluir antes da liberação de A.

Esse cenário passou nos testes.

Ele demonstra que a implementação não serializa globalmente todas as carteiras.

### Trade-off

O bloqueio pessimista reduz o risco de lost updates e facilita a consistência, mas pode elevar a latência em carteiras muito disputadas.

## 7. Idempotência financeira

A idempotência persiste no PostgreSQL.

### Identidade externa

```text
providerId + externalTransactionId
```

### Chave de idempotência

A API exige:

```http
Idempotency-Key: provider-a:bet-123
```

O banco utiliza `UNIQUE(idempotency_key)` global.

Por esse motivo, recomenda-se incluir o namespace do provedor na chave.

### Payload hash

O payload de negócio é transformado em uma representação canônica e recebe hash SHA-256.

O identificador de transporte e o cabeçalho de idempotência não integram o hash do conteúdo financeiro.

### Requisição repetida

Se identidade e payload coincidirem, o caso de uso devolve o resultado original:

```json
{
  "idempotentReplay": true
}
```

Nenhum novo movimento financeiro é realizado.

### Conflito

Se a identidade corresponder a conteúdo financeiro diferente, o processamento retorna erro de conflito.

No HTTP, o contrato utiliza `409 Conflict`.

### Trade-off

A chave global simplifica a unicidade, mas exige disciplina na geração das chaves entre provedores.

Uma alternativa futura seria modelar a unicidade como chave composta por provedor.

## 8. Transactional Inbox

A Inbox protege contra redelivery de mensagens SQS.

Sua identidade é:

```text
consumerName + messageId
```

O processamento financeiro e o registro da Inbox ocorrem na mesma transação PostgreSQL.

### Se houver falha antes do commit

Nenhuma confirmação parcial da Inbox permanece no banco.

A mensagem pode ser entregue novamente.

### Se houver falha depois do commit

A mensagem pode ser reentregue, mas a Inbox e a identidade financeira permitem recuperar o processamento já confirmado.

A Inbox e a idempotência financeira são mecanismos complementares.

## 9. Atomicidade financeira

Uma transação financeira pode envolver:

- Inserção da WagerTransaction;
- Atualização da Wallet;
- Inserção do ledger;
- Registro da Inbox;
- Registro dos eventos na Outbox.

Essas alterações ocorrem na mesma transação SQL quando aplicáveis.

### Falha antes do commit

O PostgreSQL faz rollback.

Nenhuma alteração parcial deve ser confirmada.

### Falha após commit

O resultado financeiro já está persistido.

Uma repetição recupera o estado por idempotência, sem realizar nova movimentação.

Os testes incluem falhas simuladas antes do commit e recuperação após confirmação.

## 10. Transactional Outbox

A Outbox resolve o problema de dual write entre PostgreSQL e SQS.

Sem Outbox, a aplicação poderia:

1. Confirmar a alteração financeira;
2. Falhar antes de publicar o evento.

A operação permaneceria registrada, mas o evento seria perdido.

### Fluxo adotado

```text
BEGIN
  Processar transação
  Atualizar carteira
  Inserir ledger
  Registrar evento na Outbox
COMMIT

OutboxPublisher
  Ler eventos pendentes
  Publicar no SQS
  Confirmar publicação no banco
```

### Coordenação concorrente

O publisher utiliza:

```sql
FOR UPDATE SKIP LOCKED
```

A seleção evita que publishers concorrentes processem simultaneamente a mesma linha.

Também respeita a seleção do evento pendente mais antigo por agregado, preservando a ordem operacional de publicação.

### Retry

Falhas geram:

- Incremento de tentativas;
- Data para nova tentativa;
- Backoff;
- Permanência do evento como pendente.

### Garantia

A publicação é **at-least-once**.

Se o SQS aceitar o evento, mas a confirmação se perder, uma segunda publicação poderá ocorrer.

A aplicação não promete entrega exactly-once pelo broker.

Consumidores externos devem usar o identificador estável do evento para deduplicação.

### Trade-off

A Outbox adiciona tabelas, consultas e um worker.

A implementação também mantém locks SQL durante o envio ao SQS, aumentando o tempo potencial das transações de publicação.

Em troca, preserva a intenção de publicar eventos financeiros após confirmação do banco.

## 11. Processamento SQS

O serviço utiliza filas FIFO.

```text
wager-transactions.fifo
wager-transactions-dlq.fifo
wager-events.fifo
wager-events-dlq.fifo
```

### Entrada

O consumidor recebe envelopes:

```text
WagerTransactionRequested
```

A mensagem é validada e convertida para os dados de entrada do caso de uso financeiro.

### Reutilização do processamento

A API HTTP e o consumidor SQS utilizam o mesmo `ProcessWagerTransactionUseCase`.

Assim, regras de saldo, referência, idempotência e reversão não precisam ser implementadas separadamente em cada transporte.

### ACK

O consumidor confirma a mensagem somente após o caso de uso retornar do processamento transacional.

### Erros terminais

Conflitos de idempotência e determinadas violações de validação são tratados como erros terminais.

### Erros transitórios

Falhas que podem ser recuperadas não recebem ACK definitivo.

A mensagem pode voltar após o período configurado de visibilidade.

### DLQ

A política de redrive encaminha mensagens repetidamente malsucedidas para a Dead Letter Queue.

### Trade-off

SQS FIFO oferece ordenação por grupo e deduplicação temporária, mas não substitui os mecanismos de integridade do banco.

## 12. Referências fora de ordem

REFUND e ROLLBACK podem depender de operações que ainda não foram recebidas.

A arquitetura permite o estado:

```text
PENDING_REFERENCE
```

O `PendingReferenceWorker` busca operações elegíveis e tenta processá-las novamente.

### Política de resolução

A implementação possui:

- Limite máximo de 12 tentativas;
- TTL de referência de 24 horas;
- Agendamento com backoff;
- Consulta periódica;
- Lotes limitados;
- Concorrência limitada.

Esses limites reduzem reprocessamento indefinido.

### Resultado possível

A operação pode terminar:

- `PROCESSED`, quando a referência é encontrada e validada;
- `REJECTED`, quando a referência é incompatível ou a política de resolução se esgota;
- `PENDING_REFERENCE`, enquanto a próxima tentativa ainda é permitida.

Nenhum efeito financeiro é antecipado durante o estado pendente.

## 13. Contratos HTTP

A API utiliza DTOs e validação com class-validator.

O dinheiro é recebido como string decimal, nunca como número binário.

### Estados e status

| Situação | HTTP |
|---|---|
| Operação processada | 200 |
| Carteira criada | 201 |
| Operação pendente | 202 |
| Entrada malformada | 400 |
| Recurso inexistente | 404 |
| Idempotência conflitante | 409 |
| Violação financeira de negócio | 422 |
| Falha transitória representada como indisponibilidade | 503 |

### Validação de erros

As exceções de domínio são traduzidas para códigos HTTP apropriados pelo filtro global.

Foram acrescentados testes para:

- BET de valor zero;
- Carteira pertencente a outro jogador;
- Moeda diferente da carteira;
- REFUND sem referência;
- UUID inválido;
- Abertura com saldo negativo.

Os casos de aposta inválida também verificam a ausência de mudança no saldo.

### Consultas

A aplicação permite:

- Consulta de carteira;
- Consulta de transação por ID interno;
- Consulta por identidade externa;
- Ledger paginado;
- Reconciliação.

## 14. Ledger e reconciliação

A carteira mantém o saldo materializado para consultas rápidas.

O ledger registra os movimentos necessários para reconstruí-lo.

A reconciliação compara:

```text
Saldo armazenado
       versus
Saldo reconstruído pelos lançamentos
```

O PostgreSQL calcula os valores usando `NUMERIC`.

O contrato retorna:

- `walletId`;
- `storedBalance`;
- `calculatedBalance`;
- `difference`;
- `consistent`;
- `checkedEntries`.

### Consistência da leitura

O cálculo utiliza uma consulta SQL que lê a carteira e agrega os lançamentos em um mesmo statement.

Isso evita comparar dados obtidos de duas consultas independentes realizadas em instantes diferentes.

### Divergência

Quando o saldo materializado diverge do ledger, a aplicação sinaliza a inconsistência.

Não há correção silenciosa automática.

### Limitação

A reconciliação é oferecida por endpoint.

Não foi demonstrado um job independente que reconcilie periodicamente todas as carteiras do sistema.

## 15. Observabilidade

A observabilidade inclui health checks, métricas e logs.

### 15.1. Health checks

```http
GET /health/live
GET /health/ready
```

Liveness verifica a aplicação.

Readiness verifica a comunicação com PostgreSQL e SQS.

### 15.2. Métricas

```http
GET /metrics
```

A saída utiliza formato compatível com Prometheus.

#### Métricas persistidas

- Transações por tipo e status;
- Registros processados da Inbox;
- Eventos pendentes na Outbox;
- Tentativas adicionais registradas na Outbox;
- Idade dos eventos pendentes;
- Atraso médio entre criação e publicação;
- Tempo médio de processamento persistido.

#### Métricas SQS

- Contagem aproximada de mensagens nas DLQs;
- Mensagens visíveis e em trânsito.

#### Métricas HTTP

- Requisições financeiras por resultado;
- Replays idempotentes observados;
- Conflitos SQL propagados;
- Histograma de latência;
- Reconciliações realizadas;
- Divergências encontradas.

### Limitações

Contadores HTTP são locais à instância e reiniciam quando o processo é reiniciado.

Eles não representam necessariamente todas as ocorrências SQS nem todos os conflitos recuperados internamente.

As métricas do PostgreSQL representam o estado compartilhado no momento da consulta.

### 15.3. Logs

As requisições HTTP utilizam:

```text
X-Correlation-Id
```

Um valor válido é preservado. Na ausência de identificador válido, a aplicação gera um UUID.

Os logs HTTP incluem, quando disponíveis:

- `correlationId`;
- `transactionId`;
- `walletId`;
- `providerId`;
- Método e rota;
- Status final;
- Duração;
- Nome do erro.

O interceptor registra a conclusão ao terminar a resposta HTTP.

Um teste de regressão confirmou o status `409` para um conflito de idempotência.

Os workers também utilizam eventos de log estruturados.

### Limitação da correlação

A correlação ponta a ponta entre HTTP, Inbox, Outbox e SQS ainda não foi demonstrada por um teste específico.

Embora os eventos de domínio possuam identificadores de correlação, não se afirma que o cabeçalho HTTP seja integralmente propagado por todo o fluxo distribuído.

## 16. Encerramento gracioso

O bootstrap NestJS utiliza:

```typescript
app.enableShutdownHooks();
```

Os workers implementam hooks de ciclo de vida.

### OnModuleDestroy

Os workers interrompem o agendamento de novos ciclos e aguardam os ciclos já iniciados.

O serviço SQS permanece disponível para ACK e atualização de visibilidade.

### BeforeApplicationShutdown

Após a finalização dos workers, recibos SQS ainda não confirmados podem ser liberados com:

```text
VisibilityTimeout = 0
```

O cliente AWS é encerrado em seguida.

### Validações realizadas

Um teste de integração com SQS real confirmou:

1. Recebimento de mensagem por uma instância;
2. Ausência de ACK;
3. Execução dos hooks;
4. Liberação do recibo;
5. Reentrega da mesma mensagem para outra instância.

Também foi executada a aplicação dentro de um container Linux.

O Docker enviou SIGTERM e o processo terminou com:

```text
Application readiness: OK
SIGTERM delivered: OK
SQS shutdown hook: OK
SQS release failures: 0
Container exit code: 0
```

### Limitação

O teste Linux demonstrou o encerramento correto do processo, mas não simulou uma transação financeira intencionalmente interrompida no meio do commit.

## 17. Migrations reversíveis

O schema é versionado com três migrations:

```text
Migration202611120001
Migration202611130002
Migration202611130003
```

O verificador:

```text
scripts/verify-migration-rollback.ts
```

cria um banco PostgreSQL local temporário e executa:

```text
1. UP das três migrations
2. Conferência das tabelas
3. DOWN individual das três
4. Conferência da remoção das tabelas
5. UP novamente
6. Conferência da estrutura reaplicada
7. Exclusão do banco temporário
```

Resultado confirmado:

```text
MIGRATION VERIFICATION SUCCESSFUL

Initial UP: OK
Individual DOWN: OK
Schema cleanup: OK
Second UP: OK
Original development database: UNCHANGED
```

A reversão do schema foi validada em banco descartável.

Isso não representa uma política de reversão de dados financeiros em produção.

## 18. Estratégia de testes

A suíte utiliza Bun Test.

### Testes unitários

Cobrem:

- Money;
- Wallet;
- WagerTransaction;
- WalletMapper;
- Regras de transição;
- Imutabilidade;
- Exceções e invariantes.

### Testes de integração PostgreSQL

Cobrem:

- Persistência;
- Constraints;
- Imutabilidade do ledger;
- Atomicidade;
- Concorrência;
- Reconciliação;
- Reversões;
- Recuperação após falhas.

### Testes HTTP

Cobrem:

- Criação e consulta de carteiras;
- BET e replay;
- Contratos de resposta;
- Idempotência conflitante;
- Validação de entradas;
- Status 200, 202, 400, 409 e 422;
- Health checks;
- Métricas;
- Correlação.

### Testes SQS

Cobrem:

- Envio e recebimento;
- Transactional Inbox;
- Transactional Outbox;
- Reentrega;
- Retry;
- DLQ;
- Publishers concorrentes;
- Liberação de mensagens no shutdown.

### Testes de concorrência distribuída

Cobrem:

- Dois débitos disputando o mesmo saldo;
- Cinquenta entregas idênticas;
- Três processos Bun independentes;
- Crash simulado após commit;
- Processamento independente entre carteiras distintas.

### Último resultado confirmado

Em 13/11/2026:

```text
86 pass
0 fail
500 expect() calls

Ran 86 tests across 23 files
```

A suíte completa passou novamente em infraestrutura limpa.

## 19. Validação operacional

O projeto possui scripts independentes de verificação.

| Verificação | Resultado |
|---|---|
| Instalação pelo lockfile | Aprovado |
| Build NestJS | Aprovado |
| PostgreSQL novo | Aprovado |
| Aplicação das migrations | Aprovado |
| Criação das filas SQS | Aprovado |
| 86 testes automatizados | Aprovado |
| Reversão das migrations | Aprovado |
| Reaplicação das migrations | Aprovado |
| Reentrega após shutdown | Aprovado |
| SIGTERM no Linux | Aprovado |

### Infraestrutura limpa

Script:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify-clean.ps1
```

Utiliza o projeto Docker isolado `wagering-verify`.

Portas:

```text
PostgreSQL: 5543
MiniStack:  5566
```

Ao finalizar, remove somente a infraestrutura de teste.

### Resultado final

```text
VALIDATION SUCCESSFUL

Dependencies: OK
Fresh PostgreSQL: OK
Database migrations: OK
SQS queues: OK
TypeScript build: OK
Test suite: OK
```

### SIGTERM

Script:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify-sigterm.ps1
```

A verificação foi concluída com código de saída zero e encerramento dos workers.

## 20. Segurança

A autenticação externa dos provedores não foi implementada nesta versão.

A prioridade foi demonstrar consistência financeira, concorrência, idempotência, mensageria e recuperação.

### Proposta de evolução

Para produção, recomenda-se integrar um Identity Provider OIDC, como Keycloak ou Zitadel.

A autenticação poderia ser realizada por um guard NestJS responsável por:

1. Validar o token;
2. Identificar o provedor autenticado;
3. Autorizar o acesso à carteira e à transação;
4. Vincular o provedor autenticado à identidade financeira;
5. Impedir operações sobre recursos de outro provedor.

A identidade do provedor não deve ser confiada exclusivamente ao payload HTTP.

### Métricas

O endpoint `/metrics` utiliza token configurável.

Em produção, a ausência de token desabilita o acesso às métricas.

### Limitação atual

Os endpoints financeiros não devem ser expostos diretamente à internet sem autenticação e autorização adequadas.

## 21. Trade-offs técnicos

| Decisão | Benefício | Custo |
|---|---|---|
| Monólito modular | Organização com menor complexidade operacional | API e workers compartilham aplicação |
| PostgreSQL como autoridade | Consistência transacional | Dependência do banco |
| MikroORM | Migrations e contexto transacional | Configuração adicional |
| Decimal.js | Precisão financeira | Dependência externa |
| Advisory locks | Coordenação de identidades entre processos | Contenção para a mesma identidade |
| Lock pessimista de carteira | Evita lost updates | Espera em carteiras disputadas |
| Idempotência persistente | Segurança após reinício | Consultas e armazenamento |
| Chave global | Unicidade simples | Namespace entre provedores |
| Transactional Inbox | Reentrega segura | Escrita adicional |
| Transactional Outbox | Recuperação da publicação | Worker e retries |
| SQS FIFO | Ordenação por grupo | Não elimina duplicatas financeiras sozinho |
| Ledger append-only | Auditabilidade | Crescimento do histórico |
| Métricas no PostgreSQL | Estado compartilhado | Consultas periódicas |
| Contadores HTTP locais | Implementação simples | Não agregam instâncias |

## 22. Limitações conhecidas

### Autenticação

Não foi integrada uma solução OIDC para os provedores.

### Observabilidade distribuída

A correlação completa entre requisições HTTP, mensagens SQS e eventos da Outbox não foi comprovada por teste ponta a ponta.

### Métricas

Contadores HTTP são locais à instância e não utilizam uma plataforma externa de agregação.

### Entrega dos eventos

A Outbox utiliza publicação at-least-once.

Duplicatas continuam possíveis e devem ser tratadas pelos consumidores.

### SIGTERM durante commit

O encerramento real foi validado em Linux, mas o teste não interrompeu intencionalmente uma transação no instante do commit.

### Infraestrutura com múltiplas réplicas

Foram testados três processos Bun independentes.

Não foi demonstrada uma implantação completa com três réplicas Docker da aplicação.

### Performance

Não foi executado benchmark formal de throughput ou percentis de latência p50, p95 e p99.

### Produção

Ainda seriam necessários:

- Autenticação e autorização;
- Gestão de segredos;
- Políticas de acesso;
- Dashboards e alertas;
- Monitoramento centralizado;
- Estratégia operacional de backup e recuperação.

## 23. Evoluções futuras

Possíveis melhorias:

1. Integração OIDC e autorização por provedor;
2. Propagação completa de correlationId;
3. OpenTelemetry para tracing distribuído;
4. Prometheus e dashboards centralizados;
5. Reconciliador financeiro periódico;
6. Testes de carga e throughput;
7. Testes de interrupção durante commit;
8. Execução de múltiplas réplicas Docker;
9. Políticas de deploy e rollback;
10. Fortalecimento de segurança para produção.

Essas evoluções não substituem as garantias já implementadas no domínio e no PostgreSQL.

## 24. Conclusão

A arquitetura foi desenvolvida para preservar a integridade financeira em cenários de concorrência, duplicação de mensagens e falhas transitórias.

As decisões centrais incluem:

- Dinheiro como Value Object decimal exato;
- Regras financeiras no domínio;
- PostgreSQL como autoridade do estado;
- Locks transacionais por identidade e carteira;
- Idempotência persistente;
- Ledger append-only;
- Inbox e Outbox transacionais;
- Processamento SQS at-least-once;
- Reconciliação independente do saldo materializado;
- Observabilidade;
- Encerramento gracioso;
- Migrations reversíveis;
- Testes reais de integração e concorrência.

A solução não pressupõe ausência absoluta de falhas nem exactly-once fornecido pelo broker.

Em vez disso, combina persistência, transações, idempotência e recuperação para que **reentregas e interrupções não provoquem efeitos financeiros duplicados ou saldos inválidos**.

A última execução completa, em infraestrutura limpa, terminou com:

**86 testes aprovados, zero falhas e 500 asserções.**
