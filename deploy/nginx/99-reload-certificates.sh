#!/bin/sh
set -eu

(while sleep 21600; do
  nginx -s reload
done) &
