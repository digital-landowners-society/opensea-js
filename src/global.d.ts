/* eslint-disable import/no-unused-modules */
// NO IMPORTS HERE
// Should be top-level

declare module "web3_beta";
declare module "web3-provider-engine";
declare module "web3-provider-engine/subproviders/rpc";

/* tslint:enable */
declare module "*.json" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json: any;
  /* tslint:disable */
  export default json;
  /* tslint:enable */
}

declare module "ethereumjs-abi" {
  const methodID: (name: string, types: string[]) => Buffer;
  const rawEncode: (argTypes: string[], args: unknown[]) => Buffer;
}
