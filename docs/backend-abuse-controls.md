# Segurança e limites no servidor

Segredos, autenticação, autorização, criptografia, assinatura de webhooks,
concessões comerciais e contadores permanecem no backend. Controles visuais
continuam sendo apenas UX: nenhuma permissão ou cobrança é autorizada pelo
JavaScript do navegador. Não há mecanismo de saque neste repositório; a
integração de cobrança não recebe uma função de saque como parte desta mudança.

Os módulos de autenticação e de proteção HTTP usam `server-only`: importá-los
em um Client Component faz o build falhar. Os módulos compartilhados com o
worker Node não recebem esse marcador, pois ele exige o resolvedor do Next.
`npm run build` verifica os arquivos públicos JS/HTML/RSC gerados e falha se
valores configurados de segredos backend aparecerem neles. A verificação não
imprime valores. Trata-se de defesa contra regressão, não de promessa de detectar
qualquer codificação/obfuscação deliberada ou segredo emitido apenas em runtime.

## Orçamentos independentes

| Operação | Limite | Identidade estabelecida no servidor |
| --- | --- | --- |
| API geral | 600/minuto | IP do proxy confiável |
| Solicitações de login, inclusive Server Action | 30/15 minutos | IP |
| Verificações de magic link | 30/15 minutos | IP |
| Envio efetivo de magic link (já existente) | 10/IP e 5/e-mail por 15 minutos | IP e e-mail normalizado |
| Novo checkout | 10/15 minutos | Workspace e usuário autenticado OWNER |
| Cancelamento de renovação | 10/15 minutos | Workspace e usuário autenticado OWNER; separado do checkout |
| Ativação de trial | 10/15 minutos | Workspace e usuário autenticado OWNER |
| Preparar/confirmar/apagar mídia | 360/15 minutos | Workspace, após OWNER/ADMIN; leitura não consome esse orçamento |
| Criar publicações/lotes ou retomar lote | 120/minuto | Workspace autenticado, após OWNER/ADMIN |

Um lote normal de 100 arquivos usa 100 preparações e 100 confirmações; sua
capacidade não é compartilhada com cancelamento financeiro. Pausar/cancelar
publicações continua disponível sem licença comercial, sujeito ao limite HTTP
geral. Cotas mensais de contas, membros, DMs, publicação e armazenamento,
idempotência financeira e limites Meta continuam sendo verificados no servidor.

Redis executa incremento e expiração atomicamente. As chaves contêm HMAC,
não IP/e-mail/session token em claro, e expiram junto da janela. Os novos budgets
usam namespaces derivados do ambiente do servidor: preview não consome os
novos budgets de produção, mesmo que Redis e segredo estejam compartilhados.
Respostas 429
incluem Retry-After e no-store. Falha de Redis bloqueia a admissão com 503;
não cria contadores locais independentes nem libera compras/ações sem controle.
O cliente Redis de HTTP tem conexão/comando limitados a 1,5 segundo, sem fila
offline ou retries ilimitados; as conexões BullMQ permanecem intactas.

Na Vercel, usa-se preferencialmente `x-vercel-forwarded-for`. Fora dela,
headers de IP só são aceitos com `TRUST_PROXY_HEADERS=true`, depois de configurar
um proxy que os sobrescreva e impedir acesso direto à origem. Sem isso, usa-se
um único bucket `unknown`, conservador. Não definir essa opção no frontend.

Webhooks Meta/Asaas/Zernio e cron não entram no bucket geral do navegador:
mantêm suas assinaturas/tokens, limites de corpo, deduplicação e autorização.
Isso evita que o IP compartilhado de um provedor ou uma falha do Redis bloqueie
entrega financeira legítima. Não é um WAF nem substitui proteção DDoS da borda.

Erros internos de saúde, assinatura de upload, OAuth e Zernio não são repassados
em texto bruto ao navegador. OAuth persiste/loga códigos permitidos em vez do
objeto de exceção; Zernio mantém orientação segura para erros conhecidos.
`/api/health` mantém estado, fila e tempos para monitoramento, sem
hostname/PID, stack, credenciais ou texto bruto de exceção.

## Verificação e implantação

CI usa PostgreSQL e Redis descartáveis; testes validam concorrência, TTL,
isolamento de budgets/tenants, negação antes de efeitos financeiros e privacidade
do output público. Nenhum teste de inundação ou cobrança é executado em produção.
Não há migração, mudança de segredo ou contratação de serviço. Rever os limites
com tráfego real antes de qualquer ajuste; implantar somente após revisão e
aprovação. Rollback é o deploy web anterior, mantendo TTLs para expiração normal.

Referências: [Next: segurança de dados](https://nextjs.org/docs/app/guides/data-security),
[Vercel: headers de requisição](https://vercel.com/docs/headers/request-headers),
[OWASP: throttling de autenticação](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html).
