# Servidor MCP local do PING CHAT

## Estado desta entrega

Este primeiro corte implementa somente o transporte MCP local. Ele:

- usa Streamable HTTP e aceita clientes das eras 2026 e 2025;
- escuta exclusivamente em `127.0.0.1`;
- expõe `GET /health` e o endpoint `/mcp`;
- valida `Host` e `Origin`, limita headers, corpo, conexões e tempo de request;
- registra metadados operacionais sem headers, tokens, query strings ou corpo;
- encerra o handler e o servidor HTTP de forma graciosa;
- anuncia uma lista vazia de tools.

Não há OAuth, acesso ao banco, tools de negócio, conexão real com Claude ou
ativação de campanhas nesta entrega. O status `authentication: not-configured`
do health check é intencional. O servidor não deve ser publicado nem exposto
por proxy até o fluxo OAuth e o isolamento por workspace serem implementados.

## Execução local

Requer Node.js 24, conforme o `package.json` do projeto.

```bash
npm install
npm run mcp:dev
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
npm test -- __tests__/mcp-server.test.ts
npm run build
```

Ainda não há instrução de configuração do Claude: oferecer uma configuração
antes da autenticação remota criaria uma expectativa falsa de integração.

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

Em 29 de outubro de 2026, `npm audit --omit=dev --ignore-scripts` reporta 18
achados agregados na árvore existente: 4 moderados, 10 altos e 4 críticos. O
caminho de runtime do adaptador MCP usa as versões corrigidas de Hono citadas
acima; o achado remanescente de `@hono/node-server` pertence à ferramenta de
desenvolvimento do Prisma.

Os demais achados envolvem principalmente Auth.js, Next.js, Prisma, Nodemailer
e suas dependências. Atualizações potencialmente incompatíveis não foram
misturadas neste PR de transporte. Elas exigem uma entrega de hardening
dedicada e são bloqueadoras para expor OAuth remoto ou iniciar o beta.

## Limites de segurança verificados

- o bind é literal e não configurável em `127.0.0.1`; somente a porta pode ser
  alterada;
- `tools/list` retorna uma lista vazia para clientes MCP modernos e legados;
- os módulos MCP não importam Prisma, serviços de Instagram ou envio de DM;
- não existe rota MCP no Next.js nem endpoint OAuth parcial;
- nenhuma chamada do servidor lê `DATABASE_URL`, cookies de navegador ou
  tokens Meta;
- logs contêm somente evento, request id, método, path sem query, status,
  duração e nome da classe de erro.

Esses limites são garantias deste corte local, não substituem autenticação. Um
proxy, túnel ou bind externo invalidaria o modelo de ameaça e não é suportado.

## Próxima dependência

O PR de autenticação deverá substituir a exposição apenas local por uma
superfície remota protegida, com OAuth 2.1, PKCE, resource/audience binding,
escopos mínimos, expiração, revogação, rate limiting e autorização explícita
por workspace. Nenhuma tool de leitura ou escrita deve ser adicionada antes
desse limite de confiança.
