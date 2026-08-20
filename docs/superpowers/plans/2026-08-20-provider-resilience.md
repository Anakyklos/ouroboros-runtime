# Provider Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implementar a camada comum de retry limitado, rate limit por `credentialScope` e circuit breaker por `providerId`/`credentialScope` na provider boundary do Ouroboros Runtime.

**Architecture:** Criar um módulo isolado `provider-resilience.ts` com três componentes determinísticos e serializáveis: `RetryPolicy`, `CredentialScopeRateLimiter` e `CircuitBreakerRegistry`, coordenados por `ProviderResilience`. A política será injetada no `CredentialedProviderInvoker`, mantendo o provider responsável apenas por transporte, resposta e erro. O estado exportado conterá somente scopes opacos, IDs de provider, contadores e timestamps; nenhum segredo, request ou resposta.

**Tech Stack:** TypeScript strict, Bun test, APIs nativas de `AbortSignal`/`setTimeout`, `ModelProviderError`, `CredentialedProviderInvoker` e `EventBus` já existentes. Nenhuma dependência nova.

**Spec:** `/home/ubuntu/upload/pasted_content.txt` — Ouroboros Runtime — Implementar Issue #47.

## Global Constraints

- Criar branch nova baseada na `main` atual.
- Criar somente uma PR contra `main`.
- Implementar somente esta issue.
- Não iniciar #46, #48, #49 ou #50.
- Não usar @Graph Mode.
- Não adicionar dependências sem necessidade comprovada.
- Não usar chaves reais.
- Não fazer chamadas externas obrigatórias na CI.
- Não criar fallback oculto.
- Não compartilhar quota entre usuários.
- Não enfraquecer BYOK/redaction/durability.
- Não implementar NVIDIA NIM, scheduler, fila durável completa, `waiting_for_quota` final, dashboard, UI ou métricas avançadas da #49.
- Não permitir retry infinito, retry de erro permanente ou chamada após cancelamento.

---

### Task 1: Fixar o contrato e a classificação de retry com testes RED

**Files:**
- Create: `cli/src/inference/__tests__/provider-resilience.test.ts`
- Create: `cli/src/inference/provider-resilience.ts` somente depois de observar os testes falhando

**Interfaces:**
- `RetryPolicyOptions`: `maxAttempts`, `baseDelayMs`, `maxDelayMs`, `jitter`, `clock`, `random`, `sleep`, `classifyError`.
- `RetryClassification`: `{ retryable: boolean; retryAfterMs?: number }`.
- `RetryPolicy.execute<T>(operation: (attempt: number) => Promise<T>, signal?: AbortSignal): Promise<T>`.
- `classifyProviderError(error: unknown): RetryClassification`.

**Steps:**

- [ ] Escrever testes que usem `ModelProviderError` real, sem mocks do código de produção, cobrindo: erro retryable recuperado na terceira chamada; limite total de `maxAttempts`; erro permanente sem segunda chamada; cancelamento antes da primeira chamada; cancelamento durante o backoff; `retryAfterMs` prevalecendo sobre backoff; jitter full determinístico com RNG injetado.

```ts
test("retries a retryable provider error until the operation succeeds", async () => {
    let calls = 0;
    const operation = async () => {
        calls += 1;
        if (calls < 3) {
            throw new ModelProviderError("temporary", {
                kind: "network",
                retryable: true,
                fallbackAllowed: true,
            });
        }
        return "ok";
    };

    const policy = new RetryPolicy({
        maxAttempts: 3,
        baseDelayMs: 10,
        sleep: async () => undefined,
    });

    await expect(policy.execute(operation)).resolves.toBe("ok");
    expect(calls).toBe(3);
});
```

- [ ] Rodar exclusivamente a nova suíte com `bun test cli/src/inference/__tests__/provider-resilience.test.ts` e confirmar falha por módulo/API ausente, não por erro de sintaxe.
- [ ] Implementar a classificação fail-closed: `ModelProviderError` só é retryable quando `error.retryable === true` e `kind !== "cancellation"`; erros desconhecidos e erros permanentes não recebem retry; `retryAfterMs` válido é propagado.
- [ ] Implementar `RetryPolicy` com `maxAttempts >= 1`, atraso exponencial limitado por `maxDelayMs`, jitter opcional full (`random() * cappedDelay`), precedência de `retryAfterMs`, `AbortSignal` verificado antes de cada tentativa e durante o sleep, e nenhum retry depois de cancelamento.
- [ ] Rodar novamente a suíte específica e confirmar todos os testes verdes.
- [ ] Refatorar apenas após GREEN, mantendo `RetryPolicy` sem dependência de provider concreto.

---

### Task 2: Fixar rate limiter por `credentialScope` e recovery com testes RED

**Files:**
- Modify: `cli/src/inference/__tests__/provider-resilience.test.ts`
- Modify: `cli/src/inference/provider-resilience.ts`

**Interfaces:**
- `RateLimiterOptions`: `capacity`, `refillTokens`, `refillIntervalMs`, `clock`.
- `RateLimitAdmission`: `{ allowed: boolean; remaining: number; nextEligibleAt?: number; reason: "rate_limit" }`.
- `CredentialScopeRateLimiter.tryAcquire(credentialScope: string): RateLimitAdmission`.
- `CredentialScopeRateLimiter.defer(credentialScope: string, nextEligibleAt: number): void`.
- `CredentialScopeRateLimiter.snapshot(): RateLimiterSnapshot` e `restore(snapshot: RateLimiterSnapshot): void`.

**Steps:**

- [ ] Adicionar testes RED com clock controlado para provar que scopes A e B possuem tokens independentes, que esgotar A não bloqueia B, que o estado de tokens/tempo após consumo é correto, que `defer` por `Retry-After` é isolado por scope, e que `snapshot`/`restore` preserva `nextEligibleAt` sem segredo.

```ts
test("isolates token buckets by credentialScope", () => {
    let now = 1_000;
    const limiter = new CredentialScopeRateLimiter({
        capacity: 1,
        refillTokens: 1,
        refillIntervalMs: 1_000,
        clock: () => now,
    });

    expect(limiter.tryAcquire("scope-a").allowed).toBe(true);
    expect(limiter.tryAcquire("scope-a").allowed).toBe(false);
    expect(limiter.tryAcquire("scope-b").allowed).toBe(true);

    now += 1_000;
    expect(limiter.tryAcquire("scope-a").allowed).toBe(true);
});
```

- [ ] Rodar a suíte e observar falha específica pela classe/métodos ausentes.
- [ ] Implementar token bucket determinístico com mapa indexado exclusivamente por `credentialScope`, refill proporcional ao relógio injetado, capacidade limitada, `nextEligibleAt` calculado sem espera ocupada e `defer` que aplica o maior cooldown existente.
- [ ] Implementar snapshot serializável contendo apenas `credentialScope`, tokens, timestamps e cooldown; validar opções e rejeitar scope vazio, números inválidos ou timestamp anterior ao estado atual.
- [ ] Rodar a suíte específica e confirmar GREEN, inclusive o caso de restart simulado por nova instância restaurada.

---

### Task 3: Fixar circuit breaker isolado por provider/scope com testes RED

**Files:**
- Modify: `cli/src/inference/__tests__/provider-resilience.test.ts`
- Modify: `cli/src/inference/provider-resilience.ts`

**Interfaces:**
- `CircuitState`: `"closed" | "open" | "half_open"`.
- `CircuitBreakerOptions`: `failureThreshold`, `cooldownMs`, `clock`.
- `CircuitBreaker.beforeRequest(): CircuitPermit`.
- `CircuitBreaker.recordSuccess(): void`.
- `CircuitBreaker.recordFailure(counted: boolean): void`.
- `CircuitBreaker.cancelProbe(): void`.
- `CircuitBreaker.snapshot(): CircuitBreakerSnapshot`.
- `CircuitBreakerRegistry.get(providerId: string, credentialScope: string): CircuitBreaker`.

**Steps:**

- [ ] Adicionar testes RED para abertura após falhas consecutivas, bloqueio em `open`, transição para `half_open` após cooldown, sucesso fechando e zerando contagem, falha no probe mantendo `open`, concorrência de um único probe e isolamento entre provider/scope.
- [ ] Rodar somente os testes novos e confirmar que a falha decorre da ausência dos estados e registry.
- [ ] Implementar `CircuitBreaker` com threshold mínimo 1, cooldown finito, permit único em `half_open`, `nextAttemptAt` observável e sem incluir credentialRef, segredo, prompt ou resposta no snapshot.
- [ ] Implementar `CircuitBreakerRegistry` com chave composta internamente por `providerId` e `credentialScope`, snapshots independentes e restore sem fallback para outra identidade.
- [ ] Rodar a suíte específica e confirmar GREEN.

---

### Task 4: Integrar as políticas na provider boundary

**Files:**
- Modify: `cli/src/inference/provider-resilience.ts`
- Modify: `cli/src/inference/provider-security.ts`
- Modify: `cli/src/inference/InferenceSubsystem.ts`
- Modify: `cli/src/inference/index.ts`
- Modify: `cli/src/inference/__tests__/provider-resilience.test.ts`
- Modify: `cli/src/inference/__tests__/review-findings.test.ts` apenas se uma regressão de assinatura exigir cobertura de compatibilidade

**Interfaces:**
- `ProviderResilienceOptions`: opções das três políticas, `clock`, `random`, `sleep`, `onEvent`.
- `ProviderResilience.execute<T>(identity, signal, operation): Promise<T>`.
- `ProviderResilience.snapshot(): ProviderResilienceSnapshot` e `restore(snapshot): void`.
- `CredentialedProviderInvoker` recebe `ProviderResilience` opcional como quinto argumento, preservando o quarto argumento de transport existente.
- `InferenceSubsystemConfig.resilience?: ProviderResilienceOptions` e accessor `getResilience()`.

**Steps:**

- [ ] Adicionar teste RED de integração usando provider/transport fake determinístico: a chamada passa pelo retry comum, rate limiter e circuit breaker; `429` com `retryAfterMs` chama `defer` no scope correto; scopes diferentes não compartilham quota/circuito; sinal abortado durante retry não faz chamada extra.
- [ ] Adicionar teste RED de segurança: serializar `ProviderResilience.snapshot()`, eventos capturados pelo `onEvent` e erros finais; confirmar ausência de segredo sintético, `credentialRef`, prompt e resposta.
- [ ] Rodar os testes de integração e confirmar a falha antes da implementação do wrapper.
- [ ] Implementar `ProviderResilience.execute` na ordem: verificar/admitir rate limit, obter permit do circuito, executar o transport, registrar sucesso/falha classificada, aplicar `Retry-After` ao bucket do próprio scope e delegar backoff/cancelamento ao `RetryPolicy`.
- [ ] Fazer espera controlada por `sleep` injetável para rate limit/cooldown, sem scheduler completo; a espera não conta como tentativa de provider e termina imediatamente com cancelamento.
- [ ] Alterar `CredentialedProviderInvoker.complete` para envolver somente a chamada de transport em `ProviderResilience.execute`, manter o segredo registrado para redaction até o fim de todas as tentativas e redigir o erro final no `catch` existente.
- [ ] Instanciar a política no `InferenceSubsystem` apenas com configuração explícita para rate limit, mantendo retry/circuit breaker comuns disponíveis e sem ativar NVIDIA ou fallback oculto; expor a instância e suas snapshots sem alterar engines legados.
- [ ] Exportar os contratos pelo barrel `cli/src/inference/index.ts`.
- [ ] Rodar a suíte específica e os testes de segurança existentes; corrigir apenas regressões causadas pela nova assinatura.

---

### Task 5: Documentar o comportamento real e executar a validação completa

**Files:**
- Create: `docs/PROVIDER_RESILIENCE.md`
- Modify: `docs/MODEL_PROVIDER_CONTRACT.md`
- Modify: `docs/PROVIDER_CREDENTIALS.md`
- Modify: `cli/src/inference/__tests__/provider-resilience.test.ts` se a revisão encontrar lacuna objetiva

**Steps:**

- [ ] Documentar defaults, classificação de erros, precedência de `Retry-After`, cancelamento, escopos, estados do circuito, snapshot/restore, eventos observáveis e a ausência de scheduler/NVIDIA/`waiting_for_quota` final.
- [ ] Atualizar o contrato de provider para declarar que `complete` continua sem retry interno e que a camada superior, quando injetada, decide retry/espera/falha.
- [ ] Adicionar teste de redaction em logs/eventos/métricas ou estado sempre que a documentação mencionar uma superfície observável; não adicionar métricas avançadas da #49.
- [ ] Instalar deterministicamente com `bun install --frozen-lockfile` e `cd web && bun install --frozen-lockfile && cd ..`.
- [ ] Executar `bun test cli/src/inference/__tests__/provider-resilience.test.ts` e os testes de contrato/provider-security relevantes.
- [ ] Executar exatamente `bun run check`, registrando falhas preexistentes separadamente sem `skip`, `only`, `TODO`, remoção de testes ou `continue-on-error`.
- [ ] Executar `git diff --check` e uma busca de segurança por nomes de secrets nos arquivos alterados; confirmar que apenas valores sintéticos aparecem nos testes.
- [ ] Revisar o diff contra todos os itens da Issue #47 anexada e remover qualquer alteração fora do escopo.

---

### Task 6: Commit, PR única e entrega

**Files:**
- Modify: nenhum arquivo adicional além dos listados acima

**Steps:**

- [ ] Confirmar `git status`, diff, testes e SHA final na branch `issue-47-retry-rate-limit-circuit-breaker`.
- [ ] Criar um único commit de implementação com mensagem específica da Issue #47.
- [ ] Publicar a branch e abrir somente uma PR contra `main`, sem fazer merge e sem iniciar outras issues.
- [ ] Verificar a PR e anotar URL, arquivos alterados, arquitetura, testes executados, limitações e SHA final.
- [ ] Entregar ao usuário um relatório conciso apontando também qualquer validação bloqueada por infraestrutura, sem declarar sucesso sem evidência.

## Self-review against the attached specification

A camada de retry cobre máximo de tentativas, backoff, jitter, classificação, cancelamento e erros permanentes. O limiter usa exclusivamente `credentialScope`, tem estado serializável e recovery; não há integração NVIDIA. O breaker cobre `closed`, `open`, `half_open`, cooldown, probe único, sucesso, falha, observabilidade e isolamento por provider/scope. A integração ocorre no `CredentialedProviderInvoker`, acima do provider, sem espalhar retry. Os testes cobrem retry, rate limit, breaker, cancelamento e ausência de segredos. A documentação e a validação final explicitam o que permanece fora de escopo.
