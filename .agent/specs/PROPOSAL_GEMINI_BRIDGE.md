# 🌉 Proposal: Gemini Bridge Service

> **Status:** 📦 ARCHIVED  
> **Priority:** Low (Future Implementation)  
> **Created:** 2026-02-04  
> **Risk Assessment:** ~60-65% acceptable for dev use

---

## 📋 Executive Summary

Proposta para criar um microserviço Python que usa a biblioteca reverse-engineered `gemini-webapi` para acessar Gemini Gems (incluindo contexto do NotebookLM) via HTTP, eliminando a necessidade de browser automation.

### Problema Atual
O Orchestrator usa browser automation para consultar Gems com contexto NotebookLM, resultando em:
- Latência alta (5-15s por request)
- Alto consumo de recursos (Chrome/Chromium)
- Fragilidade (quebra com mudança de UI)

### Solução Proposta
HTTP bridge que replica tráfego do Gemini Web → acesso direto às Gems via API reversa.

---

## 🔧 Especificação Técnica

### Arquitetura

```
┌─────────────────────────────────────────────────────────────────┐
│                     ORCHESTRATOR (TypeScript)                   │
├─────────────────────────────────────────────────────────────────┤
│  POST http://localhost:8765/chat                                │
│  { "gem_id": "architect-123", "prompt": "Analise X..." }        │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     GEMINI BRIDGE (Python)                      │
├─────────────────────────────────────────────────────────────────┤
│  FastAPI + gemini-webapi                                        │
│  Cookies carregados de .env                                     │
│  Fallback para browser se bridge falhar                         │
└─────────────────────────────────────────────────────────────────┘
```

### Dependências

```toml
# pyproject.toml
[project]
name = "gemini-bridge"
version = "0.1.0"
dependencies = [
    "gemini-webapi>=0.4.0",  # AGPL-3.0
    "fastapi>=0.109.0",
    "uvicorn>=0.27.0",
    "python-dotenv>=1.0.0",
]
```

### Endpoints

```python
# POST /chat
{
    "gem_id": str,        # ID da Gem ou nome
    "prompt": str,
    "model": str = "gemini-3.0-flash",
    "stream": bool = False
}

# Response
{
    "text": str,
    "thoughts": str | None,
    "images": list[str],
    "success": bool,
    "error": str | None
}

# GET /gems
# Lista todas as Gems disponíveis da conta
[
    {"id": "xxx", "name": "Architect", "predefined": false},
    ...
]

# GET /health
{"status": "ok", "cookie_expiry": "2026-03-05T00:00:00Z"}
```

### Implementação Core

```python
# src/gemini_bridge/main.py
from fastapi import FastAPI, HTTPException
from gemini_webapi import GeminiClient
from pydantic import BaseModel
import os

app = FastAPI(title="Gemini Bridge")

# Inicialização lazy do client
_client: GeminiClient | None = None

async def get_client() -> GeminiClient:
    global _client
    if _client is None:
        _client = GeminiClient(
            cookies={
                "__Secure-1PSID": os.environ["GEMINI_PSID"],
                "__Secure-1PSIDTS": os.environ["GEMINI_PSIDTS"],
            },
            auto_refresh=True,
        )
        await _client.init()
    return _client


class ChatRequest(BaseModel):
    gem_id: str
    prompt: str
    model: str = "gemini-3.0-flash"


class ChatResponse(BaseModel):
    text: str
    thoughts: str | None = None
    success: bool = True
    error: str | None = None


@app.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest) -> ChatResponse:
    try:
        client = await get_client()
        response = await client.generate_content(
            req.prompt,
            gem=req.gem_id,
            model=req.model,
        )
        return ChatResponse(
            text=response.text,
            thoughts=response.thoughts,
        )
    except Exception as e:
        return ChatResponse(
            text="",
            success=False,
            error=str(e),
        )


@app.get("/gems")
async def list_gems():
    client = await get_client()
    await client.fetch_gems()
    return [
        {"id": g.id, "name": g.name, "predefined": g.predefined}
        for g in client.gems
    ]


@app.get("/health")
async def health():
    return {"status": "ok"}
```

### Configuração de Ambiente

```bash
# .env (NUNCA COMMITAR)
GEMINI_PSID=seu_cookie_aqui
GEMINI_PSIDTS=seu_outro_cookie_aqui
```

---

## 🔐 Obtenção de Cookies

### Passo a Passo

1. Abrir https://gemini.google.com no Chrome (logado)
2. DevTools (F12) → Application → Cookies → gemini.google.com
3. Copiar valores de:
   - `__Secure-1PSID`
   - `__Secure-1PSIDTS`
4. Salvar no `.env`

### Renovação
- Cookies expiram em ~30 dias
- Implementar alerta de expiração no `/health`

---

## ⚠️ Análise de Risco Detalhada

### Probabilidades

| Risco | Probabilidade | Mitigação |
|-------|---------------|-----------|
| Ban conta Google | ~2% (com conta secundária) | Usar conta descartável |
| Suspensão temporária | ~25% | Fallback para browser |
| Quebra de endpoints | ~80%/ano | Monitorar releases da lib |
| Vazamento de cookies | ~5% (boas práticas) | .env + .gitignore + secrets |

### Risk Score Final
- **Dev/Local:** 60-65% aceitável 🟡
- **Produção com conta principal:** 85-90% inaceitável 🔴

---

## 📦 Estrutura de Diretório Proposta

```
.ouroboros/
└── gemini-bridge/
    ├── pyproject.toml
    ├── src/
    │   └── gemini_bridge/
    │       ├── __init__.py
    │       ├── main.py
    │       └── config.py
    ├── .env.example
    ├── .gitignore
    └── README.md
```

---

## 🚀 Comandos de Execução

```bash
# Setup
cd .ouroboros/gemini-bridge
python -m venv venv
source venv/bin/activate  # Linux/Mac
.\venv\Scripts\activate   # Windows
pip install -e .

# Run
uvicorn gemini_bridge.main:app --port 8765 --reload

# Test
curl http://localhost:8765/health
curl -X POST http://localhost:8765/chat \
  -H "Content-Type: application/json" \
  -d '{"gem_id": "architect", "prompt": "Hello"}'
```

---

## 🔗 Integração com Orchestrator

```typescript
// cli/src/providers/gemini-bridge.ts
export class GeminiBridgeProvider implements AIProvider {
    private baseUrl = "http://localhost:8765";
    
    async chat(gemId: string, prompt: string): Promise<string> {
        const res = await fetch(`${this.baseUrl}/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ gem_id: gemId, prompt }),
        });
        
        const data = await res.json();
        if (!data.success) {
            throw new Error(data.error);
        }
        return data.text;
    }
}
```

---

## 📚 Referências

- **Biblioteca:** https://github.com/HanaokaYuzu/Gemini-API
- **Licença:** AGPL-3.0 (obriga abrir código se distribuir)
- **PyPI:** `pip install gemini-webapi`
- **Releases:** 61+ (manutenção ativa)

---

## ✅ Checklist de Implementação

- [ ] Criar conta Google secundária para dev
- [ ] Setup do projeto Python em `.ouroboros/gemini-bridge/`
- [ ] Implementar endpoints básicos
- [ ] Obter e configurar cookies
- [ ] Testar comunicação Orchestrator → Bridge
- [ ] Implementar fallback para browser automation
- [ ] Configurar alertas de expiração de cookies
- [ ] Documentar processo de renovação de cookies

---

## 📝 Notas de Implementação Futura

1. **Priorizar conta secundária** - Nunca usar conta principal do Google
2. **Fallback obrigatório** - Browser automation como backup
3. **Monitorar releases** - Assinar notificações do GitHub
4. **Rate limiting** - Max 10-20 req/min para evitar detecção
5. **Cache de respostas** - Redis/in-memory para prompts repetidos
