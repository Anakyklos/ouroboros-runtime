# PRD — Ouroboros Runtime Web UI

## Visão Geral

Interface web de monitoramento e controle do Ouroboros Runtime — agente AI self-modifying com execução em waves paralelas.

**Stack:** React 19, Vite 6, Tailwind CSS 4, Zustand 5, React Router DOM 7, Framer Motion, Lucide React, Radix UI

**Porta:** `localhost:3000` (proxy para daemon em `:3001`)

---

## Arquitetura de Navegação

| Rota | Página | Arquivo |
|---|---|---|
| `/` | Dashboard | `src/pages/dashboard.tsx` |
| `/waves` | Wave Queue | `src/pages/waves.tsx` |
| `/agents` | Agent Review | `src/pages/agents.tsx` |
| `/analysis` | Analysis | `src/pages/analysis.tsx` |
| `/logs` | Logs | `src/pages/logs.tsx` |
| `/settings` | Settings | `src/pages/settings.tsx` |

**Layout:** StatusBar (topo) + Sidebar (esquerda, 56px) + Content (área principal)

---

## Features e Requisitos

### F1: Sidebar Navigation
- Sidebar fixa à esquerda com logo OUROBOROS + ícone Orbit SVG
- 6 NavLinks com ícones Lucide (não emojis)
- Rota ativa destacada com fundo emerald/10
- Status daemon (Connected/Disconnected) no rodapé
- Botão "Stop All" com confirmação

**Critérios de Aceitação:**
- [ ] Sidebar visível em todas as rotas
- [ ] Hover mostra feedback visual (cor muda)
- [ ] Cursor pointer em todos os links
- [ ] Click navega para rota correta
- [ ] Rota ativa tem highlight verde

### F2: Status Bar
- Barra superior mostrando: status daemon, wave, tasks, tokens, mode
- Atualização em real-time via polling `/api/rpc`

**Critérios de Aceitação:**
- [ ] Visível em todas as rotas
- [ ] Mostra "Disconnected" quando daemon offline
- [ ] Texto monospace para dados numéricos

### F3: Dashboard (Grid 2x2)
- 4 quadrants: Analysis, Wave Queue, Agent Review, Execution
- Cada quadrant mostra dados reais ou EmptyState

**Critérios de Aceitação:**
- [ ] Grid 2x2 responsivo
- [ ] EmptyState com ícone SVG WifiOff quando daemon offline
- [ ] Nenhum dado mock/hardcoded

### F4: Settings Page
- **Theme:** Dark / Light / System (radio buttons)
- **Skin:** Snake / Functional / Swiss (card selector)
- **UI Scale:** Slider 50-200%
- **Behavior:** Auto-scroll logs, Confirm brake, Max entries
- **Notifications:** Sound toggles
- **Reset:** Botão restaura defaults

**Critérios de Aceitação:**
- [ ] Theme afeta `data-theme` no root
- [ ] Skin afeta `data-skin` no root
- [ ] Settings persistem em localStorage (refresh mantém)
- [ ] Cursor pointer em TODOS os botões/toggles
- [ ] Transition duration 200ms em interações

### F5: Logs Page
- Lista de log entries com level (info/warn/error), timestamp, mensagem
- EmptyState quando sem logs
- Botão "Clear" para limpar

**Critérios de Aceitação:**
- [ ] EmptyState mostra ícone InboxIcon SVG
- [ ] Cores diferentes por level (info=azul, warn=amarelo, error=vermelho)

### F6: Theme System
- **Eixo 1 — Color scheme:** dark, light, system
- **Eixo 2 — Skin:** snake (cyberpunk emerald), functional (clean blue), swiss (minimalist light)
- `data-theme` e `data-skin` no `<html>`
- Funcional override: accent #3B82F6, sem glows, text-gradient flat

**Critérios de Aceitação:**
- [ ] Skin "functional" remove glows e muda accent para azul
- [ ] Skin "swiss" aplica data-theme="swiss"
- [ ] Persistência no localStorage

---

## Bugs Conhecidos

| # | Bug | Localização | Severidade |
|---|---|---|---|
| B1 | Proxy errors flood console quando daemon offline | `vite.config.ts` | Medium |
| B2 | Swiss skin não tem suporte completo em todos os componentes | `globals.css` | High |
| B3 | Functional skin overrides limitados (alguns elementos snake vazam) | `globals.css` | Medium |
| B4 | StatusBar pode não atualizar sem daemon | `status-bar.tsx` | Low |
| B5 | UI scale slider pode quebrar layout em valores extremos | `settings.tsx` | Medium |

---

## Checklist Pre-Delivery (ui-ux-pro-max)

- [ ] Zero emojis como ícones de UI (apenas SVG Lucide)
- [ ] `cursor-pointer` em todos os elementos clicáveis
- [ ] Transitions 150-300ms em micro-interações
- [ ] `prefers-reduced-motion` respeitado
- [ ] Contraste texto 4.5:1 mínimo
- [ ] Focus states visíveis para keyboard nav
- [ ] Responsivo: 375px, 768px, 1024px, 1440px
