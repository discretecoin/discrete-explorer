var apiList = ["https://seed1.discrete.cash:9332", "https://seed2.discrete.cash:9332"];
var api = "https://seed1.discrete.cash:9332";

var blockTargetInterval = 90;
var coinUnits = 100;
var symbol = 'XDS';
var refreshDelay = 30000;
var blocksPerPage = 20;
var recentConfirmedTxBlockRange = 1000;
var avgHashrateBaselineHeight = 0;
var avgHashrateBaselineCumulativeDifficulty = "0";
// Used to rebuild the full payable address from account-number registry keys.
// Mainnet and testnet share the numeric prefix; set the HRP to "tdisc" for testnet.
var pqAddressNetworkPrefix = 0x3445db;
var pqAddressHrp = "disc";
// Discrete addresses are bech32m: HRP "disc" (mainnet) or "tdisc" (testnet),
// separator "1", then ~5k chars of bech32 data. Real validation (checksum +
// key-length check) happens in the client-side decoder; this is just a gate.
var addressPattern = new RegExp("^(disc|tdisc)1[02-9ac-hj-np-z]{1000,}$");
// Account numbers: H-I-C (base) or H-I-T-C (deposit subaddress), Luhn mod-36 check char.
var accountNumberPattern = new RegExp("^\\d+-\\d+-[0-9A-Za-z]$");
var accountNumberWithIndexPattern = new RegExp("^\\d+-\\d+-\\d+-[0-9A-Za-z]$");
