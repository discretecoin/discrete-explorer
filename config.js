var apiList = ["https://node.karbo.org:32448", "https://node.karbo.io:32448", "https://karbo.shurik.pro:32448"];
var api = "https://node.karbo.org:32448";

var blockTargetInterval = 240;
var coinUnits = 1000000000000;
var symbol = 'KRB';
var refreshDelay = 30000;
var blocksPerPage = 20;
var recentConfirmedTxBlockRange = 1000;
var avgHashrateBaselineHeight = 700000;
var avgHashrateBaselineCumulativeDifficulty = "5917824089773719";
var addressPattern = new RegExp("^K[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{94}$");
