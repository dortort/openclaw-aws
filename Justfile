default:
  @just --list

tf-bootstrap *args:
  @./scripts/tf.sh bootstrap {{args}}

tf-main *args:
  @./scripts/tf.sh main {{args}}

ecs-shell:
  @./scripts/ecs-shell.sh

smoke:
  @./scripts/smoke.sh
