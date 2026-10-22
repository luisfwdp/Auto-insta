## Resumo

<!-- O que muda e por quê. Cite o item do roadmap e os IDs do PRD (ex.: F2 · MC-1). -->

Roadmap / PRD:

## Tipo e área

- [ ] Interface (responsável: Codex)
- [ ] Backend crítico — worker, filas, Meta/Zernio, autenticação, banco (responsável: Claude Code; exige revisão humana)
- [ ] Outras rotas de API / lib
- [ ] CI, documentação ou ferramentas

## Como foi testado

<!-- Comandos executados e resultado. Explique qualquer check que não pôde rodar. -->

- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm test`
- [ ] `npm run build` (obrigatório se tocar rotas, configuração ou dependências)
- [ ] Testes de banco com `TEST_DATABASE_URL` (obrigatório se tocar `prisma/` ou queries)
- [ ] Testes novos ou atualizados cobrem a mudança
- [ ] Nenhum teste foi pulado, desabilitado ou removido

## Segurança e isolamento

- [ ] Toda query nova a dados de tenant filtra por `workspaceId` vindo de `getCurrentWorkspaceContext()`, nunca do cliente
- [ ] IDs recebidos do cliente são buscados com `{ id, workspaceId }`
- [ ] Rotas mutáveis checam papel (`canManageWorkspace` ou equivalente)
- [ ] Nenhum segredo, token ou `.env` no diff; tokens gravados cifrados com `ENCRYPTION_KEY`
- [ ] Entradas validadas (zod) e erros não vazam detalhes internos ao usuário
- [ ] Dados pessoais de contatos tratados conforme LGPD (retenção, exclusão)

## Integração Meta

- [ ] Não remove, contorna ou enfraquece a API oficial da Meta nem a verificação de assinatura de webhooks
- [ ] Novas chamadas à Graph API citam a documentação oficial e têm teste com payload anonimizado
- [ ] Respeita limites da plataforma (uma resposta privada por comentário, janela de 24h, 750 respostas/hora por conta)
- [ ] Motor de DMs (`lib/queue/**`, `worker/**`) não alterado — ou alteração com revisão específica aprovada

## Banco de dados

- [ ] Sem mudança de schema
- [ ] Migração aditiva, com default compatível, uma única por PR, testada em Postgres descartável
- [ ] Nenhuma migração executada contra banco de produção

## i18n e interface

- [ ] Textos novos nos três catálogos (`pt-BR`, `en`, `zh-TW`) com as mesmas chaves; pt-BR revisado
- [ ] Screenshots desktop e mobile anexados (mudanças visuais)
- [ ] Acessível por teclado e com contraste AA

## Licença e upstream

- [ ] `LICENSE` e créditos do OpenReply intactos
- [ ] Nenhuma dependência com licença incompatível com MIT
- [ ] Sem renomear arquivos, enums ou estruturas internas sem necessidade (compatibilidade com o upstream)

## Documentação

- [ ] `docs/` ou README atualizados quando muda comportamento, configuração ou operação
- [ ] N/A — explique:

<!-- Marque itens não aplicáveis como N/A com o motivo. PR aberto como rascunho; merge é sempre humano. -->
