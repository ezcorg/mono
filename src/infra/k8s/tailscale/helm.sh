# https://tailscale.com/kb/1437/kubernetes-operator-api-server-proxy#configuring-the-api-server-proxy-in-auth-mode

helm upgrade \
  --install \
  tailscale-operator \
  tailscale/tailscale-operator \
  --namespace=tailscale \
  --create-namespace \
  --set-string oauth.clientId=<OAauthClientId> \
  --set-string oauth.clientSecret=<OAuthClientSecret> \
  --set-string apiServerProxyConfig.mode="true" \
  --wait
