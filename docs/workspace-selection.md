# Seleção de workspace

Com `BILLING_ENABLED=true`, a preferência `User.activeWorkspaceId` seleciona o
workspace do dashboard e das APIs que usam o resolvedor compartilhado. O usuário
precisa continuar sendo membro: uma preferência removida ou revogada cai na
associação mais antiga. A escolha não altera papéis, associações nem propriedade.
Sem preferência, o comportamento anterior permanece.

`GET /api/workspace/selection` requer sessão e retorna apenas
`{ success: true, data: { activeWorkspaceId, activeWorkspaceName, workspaces } }`.
Cada workspace possui somente `id`, `name` e `role`. As propriedades ativas são
`null` quando não há associação.

`POST /api/workspace/selection` aceita somente `{ "workspaceId": "..." }`, com
limite efetivo de 4 KiB. Exige sessão e `Origin` explícito confiável. Qualquer
membro pode selecionar um workspace do qual participa, inclusive após expiração
comercial. A resposta inclui `{ id, name, role }`; selecionar não eleva o papel.
IDs sem associação retornam `404`, sem detalhes sobre o workspace solicitado.

As respostas usam `Cache-Control: private, no-store`. Erros expõem somente códigos
fixos; exceções de banco e conteúdos enviados não são serializados. Não há cookie
de seleção: a preferência fica vinculada ao usuário autenticado no banco.

Com `BILLING_ENABLED=false`, as duas operações retornam `404` antes de autenticar
ou consultar o banco; o resolvedor lê apenas a associação mais antiga, sem
consultar a coluna nova. Isso preserva a forma antiga dessas consultas.
Ativar exige primeiro a migração aditiva aprovada e a integração de todos os
resolvedores. Reverter a flag restaura a seleção anterior sem apagar preferências.

Essa proteção é restrita ao contrato de seleção. O cliente Prisma regenerado
inclui novas colunas em consultas implícitas, como `include: { user: true }` do
adaptador de sessões e consultas completas de assets. Por isso, a migração
aditiva aprovada deve ocorrer **antes do merge que dispara o deploy**, mesmo com
`BILLING_ENABLED=false`. A main anterior pode continuar usando os dados após a
adição de colunas nullable; desligar a flag não substitui essa ordem operacional.

A integração do aceite explícito de convite pode selecionar o workspace aceito
na mesma transação que grava a associação. Aceites automáticos não devem mudar a
preferência involuntariamente. Esta etapa fornece o contrato de backend; o
seletor visual depende de implementação e revisão próprias.
