# Cadastro para acessar um link de campanha

Cada botão rastreado pode solicitar nome, e-mail e telefone antes de liberar
seu destino. A opção começa desligada, inclusive para links já enviados. O
cadastro depende do link rastreado. Use esse link para distribuir o material;
um destino público pode ser compartilhado depois que alguém o recebe.

O caminho `/r/[slug]` conta a visita como antes. Para um link com cadastro,
ele redireciona à página pública `/material/[slug]`, que exibe a conta
responsável pelo link. A página tem uma assinatura de formulário válida por
30 minutos, sem dados de contato. O POST verifica origem, limite de
tentativas, os três campos e a associação do link à campanha ativa. Só
redireciona ao destino depois de persistir o cadastro cifrado. Reenviar o
mesmo formulário não duplica o registro.

`GET /api/automations/[id]/leads` lista os links e até 50 cadastros por página,
com `nextCursor` quando houver mais. `PATCH` recebe
`{ linkId, requireLead }`. `DELETE` recebe o ID do contato na query.
Essas operações exigem proprietário ou administrador do workspace da
campanha. A migração habilita RLS e concede acesso apenas ao runtime
autorizado. O nome, o e-mail e o telefone ficam cifrados e fora da telemetria.
Excluir um botão preserva os contatos anteriores; excluir a campanha ou
remover o contato exclui os registros correspondentes.

## Liberação

Aplique a migração aditiva revisada antes do deploy que usa o novo contrato.
Valide um botão de teste com dados fictícios: confira que o destino só aparece
após o POST válido e que o cadastro está disponível no workspace autorizado.
Teste uma campanha sem cadastro, um formulário expirado e o acesso por
outro workspace. O dashboard usa o mesmo contrato em um PR de interface.

Para rollback, restaure o deploy web anterior e mantenha as tabelas e
contatos. A ativação da opção pode ser revertida por botão. Não publique uma
versão antiga que redirecione diretamente pelos links com cadastro ativo se
esses destinos ainda precisarem ficar atrás do formulário.
