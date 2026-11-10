# conet-oracle-daemon

Review-only oneshot that submits one CoNET BeamioOracle update.

It talks only to `/run/wallet-signer-oracle/oracle-daemon.sock` as client
`oracle-daemon`, chain id 224422, contract
`0x77CB8358c5a37aB7190b0A2C7EaA7fEeDCF11008`, value 0. A source timestamp older
than 20 minutes is refused. A locked signer exits non-zero and is not retried.

Do not install or start it in this round. Do not start `conetOracle.service`.
See `INSTALL.txt`.
