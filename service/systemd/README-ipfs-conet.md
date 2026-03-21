# Base op-reth / op-node on ipfs.conet.network

- **Host**: `ipfs.conet.network` (public IP `38.102.126.33` at time of setup).
- **Binaries**: `/media/sda/bin/op-reth-v1.11.3`, `/media/sda/bin/op-node-latest` → `op-node-v1.16.9`.
- **Paths** (aligned with `38.102.126.30` native layout, static + ETL on `/dev/sda` → `/media/sda`):
  - Main datadir (MDBX): `/home/peter/base/op-reth`
  - Static files: `/media/sda/base/op-reth-static`
  - ETL temp: `/media/sda/baseTemp` (see `reth.toml` `[stages.etl]`)
  - op-node P2P DB: `/media/sda/base/op-node`
  - JWT: `/home/peter/base/jwt/jwt.hex` (must match between op-reth and op-node)

## Install / update units

```bash
scp service/systemd/ipfs-conet.*.service ipfs.conet.network:/tmp/
ssh ipfs.conet.network 'sudo cp /tmp/ipfs-conet.base-op-reth-native.service /etc/systemd/system/base-op-reth-native.service && sudo cp /tmp/ipfs-conet.base-op-node-native.service /etc/systemd/system/base-op-node-native.service && sudo systemctl daemon-reload'
```

## Enable and start

```bash
ssh ipfs.conet.network 'sudo systemctl enable --now base-op-reth-native.service'
# wait until Engine is up, then:
ssh ipfs.conet.network 'sudo systemctl enable --now base-op-node-native.service'
```

## Assemble pruned snapshot (after `tar.zst` unpack)

Script: `service/assemble-base-from-unpack-ipfs.sh` (run on the server; uses `tmux` session `base-assemble` if launched remotely).

- Moves `db`, `blobstore`, `reth.toml`, `known-peers.json`, `invalid_block_hooks` → `/home/peter/base/op-reth`
- Rsyncs `static_files` → `/media/sda/base/op-reth-static`, then deletes snapshot `static_files` + `etl-tmp` and removes the unpack tree
- Sets `reth.toml` `[stages.etl] dir = "/media/sda/baseTemp"` (ETL on HDD; op-reth has no CLI for this—only datadir `reth.toml`)

## Notes

- If you change **public IP**, update `--nat=extip:` and `--p2p.advertise.ip` in both units.
- `rollup.load-protocol-versions=true` matches `docker-compose-op-reth-home.yml`; if op-node/engine errors on protocol versions, try `false` (see project playbook).
- **Static path** is set in the unit: `--datadir.static-files=/media/sda/base/op-reth-static`. **ETL temp** is `/media/sda/baseTemp` via `reth.toml` (comment in unit file).
