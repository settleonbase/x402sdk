# conet-oracle-daemon

Review-only oneshot. Every run fetches public Coinbase FX and ETH-USD spot,
checks the HTTP Date header, then asks the oracle socket to sign one CoNET
BeamioOracle update.

It does not read a quote file. Commit 9677e7b only forwarded an external file
and cannot quote on its own.

Chain 224422, contract `0x77CB8358c5a37aB7190b0A2C7EaA7fEeDCF11008`, value 0,
`beamio_oracle_owner`, socket `/run/wallet-signer-oracle/oracle-daemon.sock`.
A locked signer exits non-zero. The shipped timer is not enabled.

Do not install or start it in this round. Do not start `conetOracle.service`.
See `INSTALL.txt`.
