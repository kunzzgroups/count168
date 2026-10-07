# C168 Mobile SPA — include inside count168.org / count168.site server { }
# Install: sudo cp .../c168-mobile-locations.inc /etc/nginx/snippets/c168-mobile-locations.inc
# Then: include /etc/nginx/snippets/c168-mobile-locations.inc;

location ^~ /c168_mobile/frontend/dist/assets/ {
    expires 1y;
    add_header Cache-Control "public, immutable";
    access_log off;
    try_files $uri =404;
}

location = /c168_mobile/frontend/dist/index.html {
    add_header Cache-Control "no-cache";
    try_files $uri =404;
}

location = /c168_mobile {
    return 302 /c168_mobile/login;
}

# Trailing slash must land on the app as well. Without this rule nginx serves the
# directory itself, finds no index.html in it and answers 403 — so an iOS/Android
# home-screen shortcut pinned to https://…/c168_mobile/ opens an error page
# ("web page") instead of the app.
location = /c168_mobile/ {
    return 302 /c168_mobile/login;
}

# WebKit wants the web-app manifest with a manifest MIME type; the plain .json
# mapping makes some iOS versions ignore it (and with it standalone display).
location = /c168_mobile/frontend/dist/manifest.json {
    types { application/manifest+json json; }
    add_header Cache-Control "no-cache";
    try_files $uri =404;
}

location ~ "^/c168_mobile/(login|dashboard|home|member|report|transaction|account|maintenance|more|reset-password|owner-secondary-password|user-secondary-password)(/.*)?$" {
    add_header Cache-Control "no-cache";
    try_files /c168_mobile/frontend/dist/index.html =404;
}
