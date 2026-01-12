FROM nginx:alpine

COPY index.html /usr/share/nginx/html/index.html
COPY styles.css /usr/share/nginx/html/
COPY prompts.js /usr/share/nginx/html/
COPY config*.js /usr/share/nginx/html/

EXPOSE 80