#!/bin/sh
# Alertmanager does not expand environment variables in its config file.
# This entrypoint substitutes ${VAR} placeholders from the environment into
# the template, writes the result to the runtime config, then starts
# Alertmanager with that config.
set -e

TEMPLATE=/etc/alertmanager/alertmanager.yml.tmpl
CONFIG=/etc/alertmanager/alertmanager.yml

if [ -f "$TEMPLATE" ]; then
    cp "$TEMPLATE" "$CONFIG"
    # Substitute ${VAR} and $VAR placeholders using sed
    for var in ALERT_SMTP_HOST ALERT_SMTP_PORT ALERT_SMTP_FROM ALERT_EMAIL_TO; do
        eval "val=\$$var"
        sed -i "s|\${$var}|$val|g" "$CONFIG"
        sed -i "s|\$$var|$val|g" "$CONFIG"
    done
fi

# If ALERT_WEBHOOK_TOKEN is provided via env, prefer it over the mounted
# credentials file (the mount may still contain the CHANGE_ME placeholder).
# The mounted file is read-only, so write to /tmp and point the config there.
if [ -n "$ALERT_WEBHOOK_TOKEN" ]; then
    printf '%s' "$ALERT_WEBHOOK_TOKEN" > /tmp/webhook.token
    chmod 600 /tmp/webhook.token
    sed -i 's|/etc/alertmanager/webhook.token|/tmp/webhook.token|g' "$CONFIG"
fi

exec alertmanager \
    --config.file="$CONFIG" \
    --storage.path=/alertmanager \
    "$@"
