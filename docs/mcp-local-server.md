# Servidor MCP local do PING CHAT

## Estado desta entrega

Esta entrega implementa o transporte MCP local e ferramentas seguras de elaboração. Ele:

- usa Streamable HTTP e aceita clientes das eras 2026 e 2025;
- escuta exclusivamente em `127.0.0.1`;
- expõe `GET /health` e o endpoint `/mcp`;
- valida `Host` e `Origin`, limita headers, corpo, conexões e tempo de request;
- registra metadados operacionais sem headers, tokens, query strings ou corpo;
- encerra o handler e o servidor HTTP de forma graciosa;
- vincula o processo a um único workspace escolhido pelo operador;
- lista contas e campanhas desse workspace;
- persiste campanhas novas sempre como rascunhos inativos;
- produz prévia e URL de aprovação humana.

Não há OAuth remoto nem ferramenta de envio ou ativação. O status
`authentication: not-configured` do health check significa que a segurança
depende do bind literal em loopback e do acesso local ao computador. O servidor
não deve ser publicado nem exposto por proxy até OAuth e autorização remota por
workspace serem implementados.

## Execução local

Requer Node.js 24, conforme o `package.json` do projeto.

```bash
npm install
PINGCHAT_MCP_WORKSPACE_ID="seu-workspace" npm run mcp:dev
```

O padrão é `http://127.0.0.1:3333/mcp`. Para escolher outra porta local:

```bash
PINGCHAT_MCP_PORT=3334 npm run mcp:dev
```

Verificação:

```bash
curl --fail http://127.0.0.1:3333/health
npm run typecheck
npm run lint
npm test -- __tests__/mcp-server.test.ts __tests__/mcp-campaign-tools.test.ts
npm run build
```

Conecte o Codex ao servidor já iniciado:

```bash
codex mcp add pingChat --url http://127.0.0.1:3333/mcp
codex mcp list
```

A configuração é compartilhada pelo Codex CLI e pela extensão. O formato e os
comandos seguem a [documentação oficial do Codex para MCP](https://developers.openai.com/learn/docs-mcp).

## Ferramentas

- `get_campaign_capabilities`;
- `list_instagram_accounts`;
- `list_campaigns`;
- `create_campaign_draft`;
- `preview_campaign_draft`;
- `prepare_campaign_activation`.

Não existem `send_dm`, `reply_to_comment`, `run_campaign_now` ou
`activate_campaign`. A última ferramenta retorna a tela do PING CHAT; a pessoa
revisa e ativa a campanha na interface autenticada.

## Dependências e compatibilidade

Foram fixadas versões auditáveis do SDK oficial:

- `@modelcontextprotocol/server@2.4.0`;
- `@modelcontextprotocol/node@2.1.2`;
- `@modelcontextprotocol/client@2.4.0` apenas para testes;
- `zod@4.6.7`, que elimina o alerta conhecido da faixa anterior.

O lockfile fixa ainda `@hono/node-server@2.1.5` e `hono@4.13.14` dentro do
adaptador MCP. Esses overrides evitam que o npm reutilize as versões antigas
presentes na árvore de desenvolvimento do Prisma. O cliente MCP de testes, por
sua vez, permanece em `devDependencies` e não compõe o servidor de produção.

O SDK v2 implementa a especificação estável 2026-07-28. O handler mantém o
fallback stateless oficial para clientes de 2025. Fontes primárias:

- [SDK TypeScript v2](https://ts.sdk.modelcontextprotocol.io/v2/)
- [Serving MCP over HTTP](https://ts.sdk.modelcontextprotocol.io/v2/serving/http)
- [Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)

### Snapshot da auditoria

Em 30 de outubro de 2026, `npm audit --omit=dev --ignore-scripts` retorna zero
achados após o hardening do lockfile e a remoção do transporte SMTP opcional.
O login por email usa somente Resend.

## Limites de segurança verificados

- o bind é literal e não configurável em `127.0.0.1`; somente a porta pode ser
  alterada;
- tools nunca recebem `workspaceId` do modelo; o workspace vem da configuração
  local do processo;
- toda busca por conta, campanha ou rascunho combina o ID com o workspace;
- rascunhos usam `Automation.isActive=false` e não produzem evento de envio;
- não existe rota MCP no Next.js nem endpoint OAuth parcial;
- nenhuma resposta retorna `accessToken`, credenciais ou dados de destinatários;
- logs contêm somente evento, request id, método, path sem query, status,
  duração e nome da classe de erro.

Esses limites são garantias deste corte local, não substituem autenticação. Um
proxy, túnel ou bind externo invalidaria o modelo de ameaça e não é suportado.

## Próxima dependência

Uma entrega futura poderá substituir a exposição apenas local por uma
superfície remota protegida, com OAuth 2.1, PKCE, resource/audience binding,
escopos mínimos, expiração, revogação, rate limiting e autorização explícita
por workspace. Até lá, somente o servidor local é suportado.
