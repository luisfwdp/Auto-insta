# CRIA PING — auditoria e mapa de impacto

Base auditada: `732d925` (`main`). Escopo inicial: apenas PR A. Nenhuma alteração em worker, webhook, autenticação, banco, Prisma, criptografia ou APIs Meta.

## Reaproveitamento e lacunas

| Existente | Aproveitar | Trabalho futuro |
| --- | --- | --- |
| `app/globals.css` | Tailwind 4, `.panel`, foco e redução de movimento | Migrar consumidores para tokens CRIA PING com contraste verificado |
| `lib/feature-flags.ts` | `newDesign`, server-only, desligada por padrão | Passar estado por props quando componentes client migrarem |
| `components/dashboard-shell.tsx`, `sidebar.tsx`, `top-bar.tsx` | Shell, menu mobile e navegação existentes | Marca, seleção de conta coerente e informações reais; notificações só se houver fonte disponível |
| `account-select.tsx`, `stat-card.tsx`, `status-badge.tsx`, `follower-chart.tsx` | Seleção, métricas, status e gráfico | Adotar controles comuns e estados explícitos |
| `campaign-builder.tsx`, `keyword-input.tsx`, `post-picker.tsx` | Campos e regras de criação existentes | Extrair UI comum sem mudar payloads ou validações de negócio |
| `campaign-preview.tsx` | Preview de post, comentários e DM já existe | Melhorar continuidade da sequência; identificar exemplos como simulação |
| Formulários e listas inline nas páginas | Comportamento atual | Button, Input, Select, Textarea, Toggle, Badge, Card, Tabs, Dialog, Toast, Skeleton, DataTable e EmptyState não existem como kit comum |
| `lib/i18n`, `language-switcher.tsx` | Inglês, zh-TW e pt-BR existentes | O fallback atual é **inglês**. Tornar pt-BR principal no rollout localizado, preservando escolhas en/zh-TW; não mudar isso no PR de tokens |
| `public-site-header.tsx`, `seo-page-shell.tsx`, `legal-shell.tsx`, `app/landing.css` | Estrutura pública e conteúdo legal | Branding e textos verdadeiros em pt-BR, inglês e chinês; revisão de metadados/PWA |

## Mapa de telas e entregas

| PR | Rotas / arquivos impactados | Resultado e limite |
| --- | --- | --- |
| A — `feat/criaping-design-tokens` | Root layout (somente gate), CSS novo, fontes, SVGs e `/design-system` | Fundações e inspeção visual. Não substituir semântica de cores das telas existentes |
| B — `feat/criaping-ui-components` | Novo kit em `components/`, consumidores escolhidos em incrementos | Estados de loading/sucesso/erro/vazio/disabled, labels, foco, teclado, contraste AA; sem biblioteca pesada por padrão |
| C — `feat/criaping-dashboard` | `/dashboard`, `/overview`, shell/sidebar/topbar; listas `/campaigns`, `/automations`, `/logs`, `/inbox`, `/settings`, `/diagnostics` em PRs menores conforme necessário | Navegação responsiva e dados existentes; sem novas métricas inventadas ou notificações sem origem |
| D — `feat/criaping-campaign-editor-ui` | `/campaigns/new`, `/campaigns/[id]/edit`, `/campaigns/[id]`, `/campaigns/import`, `/automations/new`, builder/picker/keywords/preview | Melhorar posts, palavras-chave, resposta pública, DM e link. Preservar backend. Separar seções visuais para futuro editor de nós sem instalar motor de fluxos |
| E — `feat/criaping-public-pages` | `/`, `/login`, `/verify-request`, `/invite/[token]`, `/templates`, `/templates/[slug]`, páginas SEO, `/privacy`, `/terms`, `/data-deletion`, `/meta-review`, `/reports/[shareSlug]`, metadados/manifest/ícones | CRIA PING, assinatura e copy brasileira original. Localização pt-BR principal com en/zh-TW alternativos. Manter contratos legais e créditos MIT |

A API atual `/api/dashboard/stats` fornece campanhas/automations, DMs, cliques, CTR, séries diárias, keywords e logs. Reutilizar esses dados; erro e ausência de dados precisam aparecer como tais. Não interpretar zero de um carregamento falho como resultado real. `/overview` e inbox já têm fontes próprias: revisar contratos existentes sem alterá-los neste trabalho de frontend.

## Decisão de isolamento

Não sobrescrever `--color-accent` neste PR: vários consumidores usam `bg-accent text-white`, que fica ilegível sobre neon. Os tokens `--cp-*` só existem sob `[data-design="criaping"]`. Sua aplicação visual começa na página de inspeção. Os componentes futuros adotam explicitamente os pares `--cp-action` / `--cp-on-action`, sem recolorir de forma cega componentes legados.

Sem flag: HTML e classes legadas preservados, sem novas fontes baixadas; `/design-system` responde 404. Com flag: root disponibiliza tokens e variáveis de fonte; a inspeção mostra a identidade. Login, dashboard e landing aguardam seus PRs. O nome comercial final é CRIA PING, wordmark CRIAPING e assinatura `by Creator Lab Connect`.

## Referências competitivas

Inspeção de READMEs, licenças e estruturas de UI públicas em 22/10/2026; não foi uma avaliação de contas autenticadas. Nenhum código, texto comercial ou asset externo foi copiado.

| Referência consultada | Evidência | Ideia de UX aplicável |
| --- | --- | --- |
| [OpenInstaDM](https://github.com/Xeven777/openinstadm) | `components/sidebar.tsx`, builder e preview; licença MIT | Navegação consistente entre campanhas e conversas; manter preview junto da edição |
| [InstaPushDM](https://github.com/sirdonvin/instapushdm) (README usa InstaAuto) | `components/inbox/ConversationList.tsx`, `ChatWindow.tsx`; MIT | Separar lista de conversas e conteúdo, com transição clara no mobile |
| [AutoDMX](https://github.com/Qaxlabs/AutoDMX) | `app/dashboard/analytics/page.tsx`: seleção de conta e estado sem conta; MIT | Explicitar perfil selecionado e orientar conexão no estado vazio |
| [Open-autoDM](https://github.com/harshithgangone/open-autodm) | `NewAutomationModal.tsx`, etapas SelectType/SelectPost/Configure; MIT | Criação progressiva e preview por etapa, sem expor opções que o MVP não oferece |

A licença do projeto permanece intacta, com os copyrights de Anish Raj e Diwen Huang. As fontes incluem os avisos OFL. Qualquer reutilização futura de código externo exige avaliar a versão e preservar suas atribuições.

## Critérios dos próximos PRs

Cada incremento deve ser pequeno e revisável, atrás de `newDesign`, com screenshots desktop/mobile e verificação ligada/desligada. Componentes e páginas migram em etapas; não renomear estruturas técnicas pelo branding. Dialog exige gestão/restauração de foco e Escape; Tabs/Select exigem teclado; Toast precisa de região live; DataTable usa tabela semântica, cabeçalhos e estado vazio. Loading não pode apagar conteúdo sem indicar atividade. Preferência de movimento reduzido deve ser respeitada.
