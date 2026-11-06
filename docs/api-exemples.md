# Exemples d'appels API

Contrat complet : [openapi.json](openapi.json) (ou `GET /api/v1/openapi.json`). `BASE=https://console.exemple.org`.

## Obtenir un jeton API

Un jeton se crée depuis une session (l'interface, ou ci-dessous) et n'est affiché qu'une fois.

```bash
curl -s -c cj -H 'content-type: application/json' -d '{"username":"admin","password":"…"}' $BASE/api/v1/session
curl -s -b cj -H 'content-type: application/json' -d '{"name":"ci","scope":"write","expiresInDays":90}' $BASE/api/v1/api-tokens
# → {"token":"cdt_…", …}   scope "read" : GET uniquement
export TOKEN=cdt_…
```

## Déployer une révision depuis un pipeline

```bash
H="Authorization: Bearer $TOKEN"
STACK=<id de la stack>
REV=$(curl -s -H "$H" $BASE/api/v1/stacks/$STACK | jq .currentRevision)

# Modifier une variable (verrou optimiste : expectedRevision)
curl -s -X PATCH -H "$H" -H 'content-type: application/json' \
  -d "{\"expectedRevision\":$REV,\"set\":{\"IMAGE_TAG\":\"1.4.2\"}}" $BASE/api/v1/stacks/$STACK/variables

# Déployer (Idempotency-Key évite un double déploiement en cas de nouvelle tentative)
OP=$(curl -s -X POST -H "$H" -H 'content-type: application/json' -H "Idempotency-Key: $(uuidgen)" \
  -d "{\"revision\":$((REV+1)),\"pullImages\":true}" $BASE/api/v1/stacks/$STACK/deploy | jq -r .operationId)

# Attendre le résultat
until [ "$(curl -s -H "$H" $BASE/api/v1/operations/$OP | jq -r .status)" != "pending" ] && [ "$(curl -s -H "$H" $BASE/api/v1/operations/$OP | jq -r .status)" != "running" ]; do sleep 2; done
curl -s -H "$H" $BASE/api/v1/operations/$OP | jq '{status, error, images}'
```

Codes utiles : `409` conflit de révision, `429` trop de tentatives, `403` jeton en lecture seule.

## Sécurité des images

```bash
curl -s -H "$H" $BASE/api/v1/images | jq '.images[] | {refs, scan: .scan.state}'
curl -s -X POST -H "$H" $BASE/api/v1/stacks/$STACK/scans               # scanner les images d'une stack
curl -s -H "$H" $BASE/api/v1/stacks/$STACK/images                     # scans + mises à jour disponibles
curl -s -X PUT -H "$H" -H 'content-type: application/json' -d '{"policy":"minor"}' \
  $BASE/api/v1/stacks/$STACK/services/web/update-policy               # suivi : same_tag|patch|minor|major|pattern
curl -s -H "$H" $BASE/api/v1/dashboard | jq '.alerts'                 # alertes (vulnérabilités, mises à jour…)
```
