---
name: Architect Gem Interaction
description: Como interagir com o Gem Architect (Anti-Vibe Workflow) via browser MCP
---

# Architect Gem Interaction

Skill para interagir com o Gem Architect no Gemini usando browser MCP.

## URLs Importantes

- **Gem Architect**: `https://gemini.google.com/gem/59819c5e4bfe`
- **Chat Gemini Normal**: `https://gemini.google.com/app`

## Fluxo Completo

### 1. Navegar ao Gem Architect

```
mcp_browsermcp_browser_navigate(url="https://gemini.google.com/gem/59819c5e4bfe")
```

> [!IMPORTANT]
> SEMPRE navigate direto pro URL do Gem. Clicar no sidebar não é confiável.

### 2. Esperar a Página Carregar

```
mcp_browsermcp_browser_wait(time=3)
mcp_browsermcp_browser_snapshot()
```

Verifique que o snapshot contém:
- `text: Architect (Anti-Vibe Workflow)` no header
- `button "Rápido"` ou `button "Pro"` no seletor de modo

### 3. Trocar para Modo Pro

```
# 1. Clicar no seletor de modo (botão "Rápido")
mcp_browsermcp_browser_click(element="Botão Rápido", ref="<ref do button Rápido>")

# 2. Snapshot vai mostrar menu com:
#    - menuitemradio "Rápido..." [checked]
#    - menuitemradio "Raciocínio..."
#    - menuitemradio "Pro..."

# 3. Clicar em Pro
mcp_browsermcp_browser_click(element="Opção Pro", ref="<ref do menuitemradio Pro>")
```

### 4. Importar Código do GitHub

```
# 1. Clicar no botão de upload
mcp_browsermcp_browser_click(element="Abrir o menu de upload de arquivo", ref="<ref>")

# 2. Snapshot mostra menu com:
#    - button "Enviar arquivos..."
#    - button "Adicionar do Drive..."
#    - button "Importar código"

# 3. Clicar em "Importar código"
mcp_browsermcp_browser_click(element="Importar código", ref="<ref>")

# 4. Digitar URL do repositório
mcp_browsermcp_browser_type(
    element="Campo URL do repositório", 
    ref="<ref do textbox>",
    text="https://github.com/RenyEnnos/ouroboros-runtime",
    submit=false
)

# 5. Clicar em Importar
mcp_browsermcp_browser_click(element="Botão Importar", ref="<ref>")

# 6. Esperar importação
mcp_browsermcp_browser_wait(time=5)
```

> [!TIP]
> A conta GitHub **RenyEnnos** já está conectada ao Gemini.

### 5. Enviar Mensagem

```
mcp_browsermcp_browser_type(
    element="Campo de entrada de texto",
    ref="<ref do textbox 'Insira um comando aqui'>",
    text="Sua mensagem aqui",
    submit=false
)
```

A mensagem é enviada automaticamente após digitar (ou clique no botão Enviar se necessário).

### 6. Aguardar Resposta

```
# Esperar a resposta gerar (Deep Research pode levar 30-60 segundos)
mcp_browsermcp_browser_wait(time=25)
mcp_browsermcp_browser_snapshot()
```

**Indicadores que a resposta terminou:**
- NÃO tem `button "Parar resposta"` no snapshot
- TEM `button "Boa resposta"` e `button "Resposta ruim"`

## Verificação de Elementos Comuns

| Elemento | Identificação no Snapshot |
|----------|---------------------------|
| Seletor de Modo | `group "Abrir seletor de modo"` contendo `button "Rápido"` ou `button "Pro"` |
| Menu Upload | `button "Abrir o menu de upload de arquivo"` |
| Campo de Texto | `textbox "Insira um comando aqui"` |
| Enviar Mensagem | `button "Enviar mensagem"` |
| Gerando Resposta | `button "Parar resposta"` presente |
| Resposta Completa | `button "Boa resposta"` e `button "Resposta ruim"` presentes |

## Capturando Respostas Completas

> [!IMPORTANT]
> Snapshots do browser MCP truncam respostas longas (mostra só ~5KB). Use estes métodos para capturar tudo.

### Método 1: Pedir Resumo (Recomendado)

Se a resposta for muito longa, envie uma mensagem de follow-up:

```
Pode resumir sua análise anterior em formato de bullet points?
```

Isso força o Architect a condensar a resposta em algo que cabe no snapshot.

### Método 2: Múltiplos Screenshots

```python
# 1. Screenshot do topo
mcp_browsermcp_browser_press_key(key="Control+Home")
mcp_browsermcp_browser_screenshot()

# 2. Scroll e screenshot novamente
mcp_browsermcp_browser_press_key(key="PageDown")
mcp_browsermcp_browser_screenshot()

# Repetir até cobrir toda a resposta
```

### Método 3: Clicar em "Mostrar raciocínio"

Se a resposta tiver um dropdown "Mostrar raciocínio", clique para ver o pensamento completo do modelo.

### Método 4: Botão Copiar + Clipboard 

Clicar no botão "Copiar" e depois verificar o clipboard:

```bash
powershell -Command "Get-Clipboard"
```

> [!WARNING]
> O botão Copiar às vezes dá timeout. Se falhar, use outro método.

---

## Troubleshooting

### Timeout em Click

Se o click der timeout, não significa que falhou. Faça um snapshot para verificar o estado:

```
mcp_browsermcp_browser_snapshot()
```

### Página não Carregou Completamente

Se o snapshot mostrar poucos elementos, espere mais:

```
mcp_browsermcp_browser_wait(time=3)
mcp_browsermcp_browser_snapshot()
```

### Caiu no Chat Normal ao invés do Gem

Verifique o snapshot. Se não tiver `text: Architect (Anti-Vibe Workflow)` no header, navegue direto pro URL do Gem novamente.
