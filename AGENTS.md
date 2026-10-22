<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Colaboração entre agentes (Claude Code × Codex)

Este repositório é o **CRIA PING** (by Creator Lab Connect), um fork do OpenReply. Estas regras valem para qualquer
agente (Claude Code, Codex ou outro) e para pessoas. O produto e o plano estão em
[docs/AUTO_INSTA_PRD.md](docs/AUTO_INSTA_PRD.md) e [docs/ROADMAP.md](docs/ROADMAP.md).

## Prioridades, nesta ordem

1. **Segurança e isolamento entre workspaces.**
2. **Sistema funcionando** — `main` sempre verde e implantável; nada quebra o envio de DMs.
3. **Integração oficial da Meta** — nunca remover, contornar ou enfraquecer.
4. Estética e rebrand.

## Regras invioláveis

- **Meta oficial apenas.** Sem scraping, automação de navegador ou senha de Instagram. Não
  alterar nem pular a verificação de assinatura de webhooks (`verifyWebhookSignature` em
  `lib/meta/webhook.ts`, `verifyZernioSignature` em `lib/zernio/normalize-event.ts`). Toda nova chamada à Graph API precisa citar a documentação
  oficial no PR e ter teste com payload anonimizado.
- **Licença e créditos.** `LICENSE` não é editado. Os créditos do OpenReply e do projeto
  original permanecem no README.
- **Compatibilidade com o upstream.** Não renomear arquivos, enums, modelos Prisma, rotas
  internas ou o nome do pacote sem necessidade. O rebrand fica na camada visível.
- **Isolamento entre workspaces.** Toda query a dados de tenant filtra por `workspaceId`
  obtido de `getCurrentWorkspaceContext()` (`lib/workspace-access.ts`), nunca de parâmetro
  enviado pelo cliente. Ao receber um ID do cliente (campanha, conta, log), buscar com
  `where: { id, workspaceId }`. Rotas mutáveis checam papel com `canManageWorkspace`.
  Contas Instagram pertencem a um único workspace (`instagramId` é único).
- **Segredos.** Nunca commitar `.env`, tokens ou chaves. Tokens de Instagram e credenciais de
  provedor são sempre cifrados com `ENCRYPTION_KEY` antes de gravar.
- **Testes.** Nunca pular, desabilitar ou apagar teste para deixar o CI verde.

## Áreas e responsáveis

| Área | Responsável principal | Revisão obrigatória |
| --- | --- | --- |
| Motor de DMs e filas: `lib/queue/**`, `worker/**`, `lib/polling/**` | Claude Code | Codex + humano |
| Integração Meta/Zernio: `lib/meta/**`, `lib/instagram/**`, `lib/zernio/**`, `app/api/webhook/**`, `app/api/zernio/**`, `app/api/instagram/**` | Claude Code | Codex + humano |
| Autenticação e acesso: `lib/auth.ts`, `lib/workspace*.ts`, `proxy.ts`, `app/api/auth/**`, `app/api/workspace/**` | Claude Code | Codex + humano |
| Banco: `prisma/schema.prisma`, `prisma/migrations/**` | Claude Code (uma migração por vez) | Codex + humano |
| Demais rotas de API (`app/api/**`), `lib/**` restante | Claude Code | Codex |
| Interface: `components/**`, `app/(dashboard)/**` (páginas), `app/*.css`, páginas públicas | Codex | Claude Code |
| Catálogos i18n `lib/i18n/*.json` | Quem altera a UI | o outro agente |
| CI e documentação | Quem abre o PR | o outro agente |

- Um agente pode propor mudança em área do outro, mas o PR pede revisão do responsável.
- **Mudanças no motor de DMs, no schema ou no banco de produção só com revisão específica
  aprovada por humano.** Migração em produção (`npm run db:migrate` contra o banco real) nunca
  é executada por agente.
- Funcionalidade de ponta a ponta: primeiro o PR de contrato (schema + API + testes) do Claude
  Code; depois de mesclado, o PR de interface do Codex consumindo esse contrato.

## Branches, commits e PRs

- Nunca fazer push direto em `main`. Nunca fazer merge automático: o merge é humano.
- Branch: `<tipo>/f<fase>-<slug>` — tipos `feat`, `fix`, `chore`, `docs`, `test`, `refactor`.
  Ex.: `feat/f2-workspace-switcher`. A sequência planejada está em `docs/ROADMAP.md`.
- Commits em Conventional Commits (`feat(worker): …`, `fix(i18n): …`).
- Um PR = um item do roadmap, pequeno e independente (objetivo: < 400 linhas, sem contar
  catálogos i18n e SQL gerado). Abrir como **rascunho** e marcar pronto só com CI verde.
- Preencher o template `.github/pull_request_template.md`; todo item não aplicável é marcado
  como "N/A" com motivo.
- Não reescrever histórico de branch de outro agente (sem rebase/force-push nele); usar merge.
- Documentar cada mudança: descrição do PR, e `docs/` quando mudar comportamento, configuração
  ou operação.

## Antes de abrir ou atualizar um PR

```bash
npm run typecheck
npm run lint
npm test
npm run build   # quando tocar rotas, configuração ou dependências
```

Testes de banco (`*.db.test.ts` e suítes com `describe.skipIf(!TEST_DATABASE_URL)`) rodam
quando `TEST_DATABASE_URL` aponta para um Postgres descartável — veja o cabeçalho de
`__tests__/tracked-link-order.db.test.ts`. Se algum check não puder rodar, explique no PR.

## Interface e idioma

- pt-BR é o idioma padrão; en e zh-TW continuam opcionais. Todo texto novo entra nos três
  catálogos de `lib/i18n/` com as mesmas chaves (o typecheck acusa chave faltando). Regras em
  `docs/localization.md`.
- Identidade: preto `#0B0B0B`, verde-limão `#C7FF2F` (texto sobre ele sempre `#0B0B0B`),
  grafite `#1A1A1A`, branco `#F5F5F5`. Tokens definidos no PRD, seção 3.
- Zernio fica só em "Integrações avançadas", sem banners, patrocínio ou recomendação comercial.
