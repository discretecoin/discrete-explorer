(function () {
    "use strict";

    if (!window.Vue) return;

    var createApp = window.Vue.createApp;
    var STORAGE_THEME_KEY = "karbo_explorer_theme_v2";
    var STORAGE_API_KEY = "karbo_explorer_api_v2";
    var COIN_UNIT_STRING = String(window.coinUnits || "1000000000000");
    var COIN_UNIT_BIGINT = BigInt(COIN_UNIT_STRING);
    var COIN_DECIMALS = Math.max(COIN_UNIT_STRING.length - 1, 0);
    var REFRESH_DELAY = Number(window.refreshDelay) || 30000;
    var DEFAULT_PAGE_SIZE = Number(window.blocksPerPage) || 20;
    var RECENT_CONFIRMED_TX_LIMIT = 20;
    var RECENT_CONFIRMED_TX_SCAN_BATCH = Number(window.recentConfirmedTxBlockRange) || 1000;
    var DATE_LOCALE = "en-GB";
    var AVG_HASHRATE_BASELINE_HEIGHT = coerceInteger(window.avgHashrateBaselineHeight);
    var AVG_HASHRATE_BASELINE_CUMULATIVE_DIFFICULTY = toBigIntValue(window.avgHashrateBaselineCumulativeDifficulty);
    var ADDRESS_PATTERN = window.addressPattern instanceof RegExp
        ? window.addressPattern
        : /^K[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{94}$/;
    var SIMPLE_ROUTE_NAMES = [
        "nodes",
        "alt-blocks",
        "tools",
        "broadcast-transaction",
        "check-funds",
        "check-payment",
        "validate-address",
        "verify-message",
        "amount-converter",
        "payment-id-tools",
        "paper-wallet",
        "settings"
    ];
    var SCRIPT_PROMISES = Object.create(null);

    function safeStorageGet(key) {
        try { return window.localStorage.getItem(key); } catch (error) { return null; }
    }

    function safeStorageSet(key, value) {
        try { window.localStorage.setItem(key, value); } catch (error) { return null; }
        return value;
    }

    function unique(values) {
        return Array.from(new Set((values || []).filter(Boolean)));
    }

    function isSimpleRouteName(name) {
        return SIMPLE_ROUTE_NAMES.indexOf(name) !== -1;
    }

    function normalizeApiUrl(url) {
        var input = String(url || "").trim();
        if (!input) return "";
        try { return new URL(input).toString().replace(/\/$/, ""); } catch (error) { return input.replace(/\/+$/, ""); }
    }

    function isValidEndpoint(url) {
        try {
            var parsed = new URL(url);
            return parsed.protocol === "https:" || parsed.protocol === "http:";
        } catch (error) {
            return false;
        }
    }

    function getPreferredTheme() {
        var storedTheme = safeStorageGet(STORAGE_THEME_KEY);
        if (storedTheme === "dark" || storedTheme === "light") return storedTheme;
        return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }

    function normalizeHex(value) {
        return String(value || "").trim().toLowerCase();
    }

    function isHexString(value, length) {
        var normalized = normalizeHex(value);
        var exactLength = typeof length === "number" ? "{".concat(length, "}") : "+";
        return new RegExp("^[0-9a-f]".concat(exactLength, "$")).test(normalized);
    }

    function coerceInteger(value) {
        if (value === null || value === undefined || value === "") return null;
        if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : null;
        if (typeof value === "bigint") return Number(value);
        var normalized = String(value).trim().replace(/,/g, "");
        if (!normalized) return null;
        if (/^-?\d+$/.test(normalized)) {
            var parsedInteger = Number(normalized);
            return Number.isFinite(parsedInteger) ? Math.trunc(parsedInteger) : null;
        }
        var parsedNumber = Number(normalized);
        return Number.isFinite(parsedNumber) ? Math.trunc(parsedNumber) : null;
    }

    function coerceBoolean(value) {
        if (typeof value === "boolean") return value;
        if (typeof value === "string") return value.toLowerCase() === "true";
        return Boolean(value);
    }

    function formatIntegerString(value) {
        var raw = String(value);
        var negative = raw.startsWith("-");
        var digits = negative ? raw.slice(1) : raw;
        return (negative ? "-" : "") + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    }

    function formatCountValue(value) {
        if (value === null || value === undefined || value === "") return "--";
        if (typeof value === "bigint") return formatIntegerString(value.toString());
        var normalized = String(value).trim().replace(/,/g, "");
        if (/^-?\d+$/.test(normalized)) return formatIntegerString(normalized);
        var parsed = Number(normalized);
        return Number.isFinite(parsed) ? parsed.toLocaleString() : String(value);
    }

    function toAtomicBigInt(value) {
        if (value === null || value === undefined || value === "") return null;
        if (typeof value === "bigint") return value;
        var raw = String(value).trim().replace(/,/g, "");
        if (!raw) return null;
        var negative = raw.startsWith("-");
        var unsigned = negative ? raw.slice(1) : raw;
        if (/^\d+$/.test(unsigned)) return BigInt((negative ? "-" : "") + unsigned);
        if (/^\d+\.\d+$/.test(unsigned)) {
            var parts = unsigned.split(".");
            var whole = parts[0] || "0";
            var fraction = (parts[1] || "").padEnd(COIN_DECIMALS, "0").slice(0, COIN_DECIMALS);
            var atomic = BigInt(whole + fraction);
            return negative ? -atomic : atomic;
        }
        var numeric = Number(raw);
        return Number.isFinite(numeric) ? BigInt(Math.trunc(numeric)) : null;
    }

    function toBigIntValue(value) {
        if (value === null || value === undefined || value === "") return null;
        if (typeof value === "bigint") return value;
        if (typeof value === "number") return Number.isFinite(value) ? BigInt(Math.trunc(value)) : null;
        var raw = String(value).trim().replace(/,/g, "");
        if (!raw) return null;
        if (/^-?\d+$/.test(raw)) {
            try { return BigInt(raw); } catch (error) { return null; }
        }
        var numeric = Number(raw);
        return Number.isFinite(numeric) ? BigInt(Math.trunc(numeric)) : null;
    }

    function renderAtomicCoins(value, precision, includeSymbol, trimTrailingZeros) {
        var atomics = toAtomicBigInt(value);
        if (atomics === null) return "--";
        var withSymbol = includeSymbol !== false;
        var negative = atomics < 0n;
        var absolute = negative ? -atomics : atomics;
        var rendered = "";
        var limitedPrecision = typeof precision === "number" && Number.isFinite(precision)
            ? Math.max(Math.min(Math.trunc(precision), COIN_DECIMALS), 0)
            : null;

        if (COIN_DECIMALS > 0) {
            var absoluteString = absolute.toString();
            var wholePart = absoluteString.length > COIN_DECIMALS
                ? absoluteString.slice(0, absoluteString.length - COIN_DECIMALS)
                : "0";
            var fractionPart = absoluteString.length > COIN_DECIMALS
                ? absoluteString.slice(absoluteString.length - COIN_DECIMALS)
                : absoluteString.padStart(COIN_DECIMALS, "0");

            if (limitedPrecision !== null) {
                fractionPart = limitedPrecision > 0 ? fractionPart.slice(0, limitedPrecision) : "";
            }

            rendered = formatIntegerString(wholePart);
            if (fractionPart) rendered += "." + fractionPart;
            if (trimTrailingZeros) rendered = rendered.replace(/0+$/, "").replace(/\.$/, "");
        } else {
            rendered = formatIntegerString(absolute.toString());
        }

        if (negative) rendered = "-" + rendered;
        if (withSymbol) rendered += " " + String(window.symbol || "KRB");
        return rendered;
    }

    function bytesToHex(bytes) {
        if (!bytes || typeof bytes.length !== "number") return "";
        var parts = [];
        for (var index = 0; index < bytes.length; index += 1) parts.push(Number(bytes[index]).toString(16).padStart(2, "0"));
        return parts.join("");
    }

    function hexToBytes(hex) {
        if (!isHexString(hex) || String(hex).length % 2 !== 0) return [];
        var bytes = [];
        for (var offset = 0; offset < hex.length; offset += 2) bytes.push(parseInt(hex.slice(offset, offset + 2), 16));
        return bytes;
    }

    function decodeBytes(bytes) {
        if (!bytes || !bytes.length) return "";
        var decoded = "";
        try {
            decoded = window.TextDecoder
                ? new TextDecoder("utf-8", { fatal: false }).decode(Uint8Array.from(bytes))
                : String.fromCharCode.apply(null, bytes);
        } catch (error) {
            decoded = "";
        }
        decoded = decoded.replace(/\u0000+$/g, "").trim();
        if (!decoded || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(decoded) || decoded.indexOf("\uFFFD") !== -1) return "";
        return decoded;
    }

    function hexToAscii(hex) {
        return decodeBytes(hexToBytes(normalizeHex(hex)));
    }

    function asciiToHex(text) {
        return String(text || "").split("").map(function (character) {
            return character.charCodeAt(0).toString(16).padStart(2, "0");
        }).join("");
    }

    function randomHex(length) {
        var size = Math.max(Number(length) || 0, 0);
        var bytes = new Uint8Array(Math.ceil(size / 2));
        window.crypto.getRandomValues(bytes);
        return bytesToHex(bytes).slice(0, size);
    }

    function loadScriptOnce(src) {
        if (SCRIPT_PROMISES[src]) {
            return SCRIPT_PROMISES[src];
        }

        SCRIPT_PROMISES[src] = new Promise(function (resolve, reject) {
            var existing = document.querySelector('script[src="' + src + '"]');
            if (existing) {
                resolve(existing);
                return;
            }

            var script = document.createElement("script");
            script.src = src;
            script.async = true;
            script.onload = function () { resolve(script); };
            script.onerror = function () { reject(new Error("Could not load " + src)); };
            document.head.appendChild(script);
        });

        return SCRIPT_PROMISES[src];
    }

    function readableError(error, fallbackMessage) {
        if (!error) return fallbackMessage;
        if (typeof error === "string") return error;
        if (error.message) return error.message;
        return fallbackMessage;
    }

    function modeSummary(values) {
        if (!values || !values.length) return { value: null, count: 0, total: 0 };
        var counts = Object.create(null);
        var bestValue = values[0];
        var bestCount = 0;
        values.forEach(function (value) {
            var key = String(value);
            counts[key] = (counts[key] || 0) + 1;
            if (counts[key] > bestCount) {
                bestCount = counts[key];
                bestValue = value;
            }
        });
        return {
            value: bestValue,
            count: bestCount,
            total: values.length
        };
    }

    function sortBlocksDescending(blocks) {
        return (blocks || []).slice().sort(function (left, right) {
            var rightHeight = coerceInteger(right && (right.height !== undefined ? right.height : right.index)) || 0;
            var leftHeight = coerceInteger(left && (left.height !== undefined ? left.height : left.index)) || 0;
            return rightHeight - leftHeight;
        });
    }

    function buildHomeBlockKey(block) {
        var height = coerceInteger(block && (block.height !== undefined ? block.height : block.index));
        if (height !== null) return "height:" + height;
        return "hash:" + String(block && block.hash || "");
    }

    function decorateHomeBlocks(blocks, tailBlock) {
        var seen = Object.create(null);
        var uniqueBlocks = [];
        (blocks || []).forEach(function (block) {
            if (!block) return;
            var key = buildHomeBlockKey(block);
            if (seen[key]) return;
            seen[key] = true;
            uniqueBlocks.push(Object.assign({}, block));
        });

        var sortedBlocks = sortBlocksDescending(uniqueBlocks);
        sortedBlocks.forEach(function (block, index) {
            var nextBlock = sortedBlocks[index + 1] || tailBlock || null;
            var currentTimestamp = coerceInteger(block.timestamp) || 0;
            var nextTimestamp = nextBlock ? (coerceInteger(nextBlock.timestamp) || 0) : 0;
            block.lapse = nextBlock ? Math.max(currentTimestamp - nextTimestamp, 0) : 0;
        });

        return sortedBlocks;
    }

    function average(values) {
        if (!values || !values.length) return 0;
        var total = values.reduce(function (sum, value) { return sum + Number(value || 0); }, 0);
        return total / values.length;
    }

    function formatEnglishLocalDate(seconds, options) {
        var numeric = Number(seconds);
        if (!Number.isFinite(numeric) || numeric <= 0) return "--";
        try {
            return new Intl.DateTimeFormat(DATE_LOCALE, options).format(new Date(numeric * 1000));
        } catch (error) {
            return new Date(numeric * 1000).toLocaleString([], options);
        }
    }

    function parseSimpleQuery(search) {
        var params = new URLSearchParams(search || "");
        var query = {};
        if (params.has("height")) query.height = params.get("height");
        if (params.has("highlight")) query.highlight = params.get("highlight");
        return query;
    }

    function normalizeRoute(route) {
        var normalized = { name: "home", params: {}, query: {} };
        if (!route || typeof route !== "object") return normalized;
        var name = typeof route.name === "string" ? route.name : "home";
        var params = route.params && typeof route.params === "object" ? route.params : {};
        var query = route.query && typeof route.query === "object" ? route.query : {};
        if (name === "home") {
            normalized.name = "home";
            if (query.height !== undefined && query.height !== null && query.height !== "") normalized.query.height = String(query.height);
            return normalized;
        }
        if (isSimpleRouteName(name)) {
            normalized.name = name;
            return normalized;
        }
        if ((name === "block" || name === "transaction" || name === "payment-id") && params.hash) {
            normalized.name = name;
            normalized.params.hash = String(params.hash).trim();
            if (name === "transaction" && query.highlight !== undefined && query.highlight !== null && query.highlight !== "") normalized.query.highlight = String(query.highlight);
            return normalized;
        }
        if (name === "address" && params.address) {
            normalized.name = "address";
            normalized.params.address = String(params.address).trim();
            return normalized;
        }
        return normalized;
    }

    function buildRouteUrl(route) {
        var normalized = normalizeRoute(route);
        var query = new URLSearchParams();
        if (normalized.name === "home") {
            if (normalized.query.height) query.set("height", normalized.query.height);
            var homeQuery = query.toString();
            return homeQuery ? "/?".concat(homeQuery) : "/";
        }
        if (isSimpleRouteName(normalized.name)) return "/".concat(normalized.name);
        if (normalized.name === "address") return "/address/".concat(encodeURIComponent(normalized.params.address));
        var path = "/".concat(normalized.name, "/").concat(encodeURIComponent(normalized.params.hash));
        if (normalized.name === "transaction" && normalized.query.highlight) query.set("highlight", normalized.query.highlight);
        var search = query.toString();
        return search ? "".concat(path, "?").concat(search) : path;
    }

    function parseLegacyRoute(locationObject) {
        var params = new URLSearchParams(locationObject.search || "");
        var hash = String(locationObject.hash || "").replace(/^#/, "").toLowerCase();
        var value = params.get("hash");
        if (value) {
            if (hash === "block") return normalizeRoute({ name: "block", params: { hash: value } });
            if (hash === "transaction") return normalizeRoute({ name: "transaction", params: { hash: value } });
            if (hash === "payment-id" || hash === "payment_id") return normalizeRoute({ name: "payment-id", params: { hash: value } });
        }
        if (hash === "nodes") return normalizeRoute({ name: "nodes" });
        if (hash === "alt-blocks" || hash === "alt_blocks") return normalizeRoute({ name: "alt-blocks" });
        if (hash === "tools") return normalizeRoute({ name: "tools" });
        if (hash === "pushtx") return normalizeRoute({ name: "broadcast-transaction" });
        if (hash === "check_funds") return normalizeRoute({ name: "check-funds" });
        if (hash === "check_payment") return normalizeRoute({ name: "check-payment" });
        if (hash === "paperwallet") return normalizeRoute({ name: "paper-wallet" });
        if (hash === "validate_address") return normalizeRoute({ name: "validate-address" });
        if (hash === "verify_message") return normalizeRoute({ name: "verify-message" });
        if (hash === "amount_converter") return normalizeRoute({ name: "amount-converter" });
        if (hash === "payment_id_gen") return normalizeRoute({ name: "payment-id-tools" });
        if (hash === "settings") return normalizeRoute({ name: "settings" });
        return null;
    }

    function parseCurrentRoute(locationObject) {
        var legacyRoute = parseLegacyRoute(locationObject);
        if (legacyRoute) return legacyRoute;
        var pathname = decodeURIComponent(String(locationObject.pathname || "/").replace(/\/index\.html$/, "/"));
        var segments = pathname.split("/").filter(Boolean);
        var query = parseSimpleQuery(locationObject.search || "");
        if (!segments.length) return normalizeRoute({ name: "home", query: query });
        if (isSimpleRouteName(segments[0])) return normalizeRoute({ name: segments[0] });
        if ((segments[0] === "block" || segments[0] === "transaction" || segments[0] === "payment-id") && segments[1]) return normalizeRoute({ name: segments[0], params: { hash: segments[1] }, query: query });
        if (segments[0] === "address" && segments[1]) return normalizeRoute({ name: "address", params: { address: segments[1] } });
        return normalizeRoute({ name: "home", query: query });
    }

    async function fetchJson(url, init) {
        var options = Object.assign({ cache: "no-store", headers: {} }, init || {});
        options.headers = Object.assign({}, init && init.headers ? init.headers : {});
        var timeoutMs = Number(options.timeoutMs);
        delete options.timeoutMs;

        var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
        var timeoutId = 0;
        var externalSignal = options.signal || null;

        if (controller) {
            if (externalSignal) {
                if (externalSignal.aborted) controller.abort();
                else externalSignal.addEventListener("abort", function () {
                    controller.abort();
                }, { once: true });
            }
            options.signal = controller.signal;
        }

        try {
            var fetchPromise = fetch(url, options);
            if (timeoutMs > 0) {
                fetchPromise = Promise.race([
                    fetchPromise,
                    new Promise(function (_, reject) {
                        timeoutId = window.setTimeout(function () {
                            if (controller) controller.abort();
                            reject(new Error("Request timed out."));
                        }, timeoutMs);
                    })
                ]);
            }

            var response = await fetchPromise;
            var payload;
            try { payload = await response.json(); } catch (error) { throw new Error("Invalid JSON response."); }
            if (!response.ok) throw new Error(payload && payload.error && payload.error.message ? payload.error.message : "Request failed.");
            return payload;
        } catch (error) {
            if (error && (error.name === "AbortError" || error.message === "Request timed out.") && timeoutMs > 0) {
                throw new Error("Request timed out.");
            }
            throw error;
        } finally {
            if (timeoutId) window.clearTimeout(timeoutId);
        }
    }

    async function fetchNodeInfo(apiUrl) {
        return fetchJson("".concat(normalizeApiUrl(apiUrl), "/getinfo"), {
            headers: { Accept: "application/json" },
            timeoutMs: 5000
        });
    }

    async function fetchNodeFee(apiUrl) {
        return fetchJson("".concat(normalizeApiUrl(apiUrl), "/feeaddress"), {
            headers: { Accept: "application/json" },
            timeoutMs: 3500
        });
    }

    async function sendRawTransaction(apiUrl, transactionHex) {
        return fetchJson("".concat(normalizeApiUrl(apiUrl), "/sendrawtransaction"), {
            method: "POST",
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                tx_as_hex: transactionHex
            })
        });
    }

    async function rpcCall(apiUrl, method, params) {
        var payload = await fetchJson("".concat(normalizeApiUrl(apiUrl), "/json_rpc"), {
            method: "POST",
            headers: { Accept: "application/json", "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: "karbo_explorer", method: method, params: params || {} })
        });
        if (payload && payload.error) throw new Error(payload.error.message || "RPC request failed.");
        return payload && payload.result ? payload.result : payload;
    }

    createApp({
        data: function () {
            var configuredApis = unique([safeStorageGet(STORAGE_API_KEY), window.api].concat(window.apiList || [])).map(normalizeApiUrl).filter(Boolean);
            var initialApi = configuredApis[0] || "";
            var initialTheme = getPreferredTheme();
            var initialRoute = parseCurrentRoute(window.location);

            return {
                route: initialRoute,
                theme: initialTheme,
                api: initialApi,
                blockTargetInterval: Number(window.blockTargetInterval) || 0,
                avgHashrateBaselineHeight: AVG_HASHRATE_BASELINE_HEIGHT,
                searchQuery: "",
                stats: null,
                statsStatus: "loading",
                lastStatsFetchedAt: 0,
                pageBusy: false,
                toast: null,
                toastTimerId: 0,
                routeRequestId: 0,
                clockTimerId: 0,
                pollTimerId: 0,
                popstateHandler: null,
                mobileHeaderScrollHandler: null,
                mobileHeaderResizeHandler: null,
                mobileHeaderLastScrollY: 0,
                mobileHeaderTicking: false,
                isMobileHeaderHidden: false,
                isCompactViewport: false,
                nowSeconds: Math.floor(Date.now() / 1000),
                primaryNav: [
                    { name: "home", label: "Overview", icon: "fa-chart-line" },
                    { name: "nodes", label: "Nodes", icon: "fa-server" },
                    { name: "alt-blocks", label: "Alt blocks", icon: "fa-code-branch" },
                    { name: "tools", label: "Tools", icon: "fa-th-large" },
                    { name: "settings", label: "Settings", icon: "fa-sliders-h" }
                ],
                toolNav: [
                    { name: "broadcast-transaction", label: "Broadcast tx", icon: "fa-broadcast-tower", description: "Submit raw transaction hex to the network." },
                    { name: "check-funds", label: "Check proof", icon: "fa-piggy-bank", description: "Verify a reserve proof and reported balance." },
                    { name: "check-payment", label: "Check payment", icon: "fa-receipt", description: "Verify received outputs for a transaction." },
                    { name: "validate-address", label: "Validate address", icon: "fa-check-circle", description: "Validate an address and inspect public keys." },
                    { name: "verify-message", label: "Verify message", icon: "fa-envelope-open-text", description: "Verify a signed message against an address." },
                    { name: "amount-converter", label: "Amount converter", icon: "fa-exchange-alt", description: "Convert atomic units to readable KRB amounts." },
                    { name: "payment-id-tools", label: "Payment ID tools", icon: "fa-fingerprint", description: "Generate, encode, and decode payment IDs." },
                    { name: "paper-wallet", label: "Paper wallet", icon: "fa-wallet", description: "Generate an offline paper wallet in-browser." }
                ],
                home: {
                    loading: false,
                    loadingMore: false,
                    error: "",
                    blocks: [],
                    mempool: [],
                    mempoolLoaded: false,
                    recentTransactions: [],
                    recentTransactionsLoading: false,
                    recentTransactionsError: "",
                    recentTransactionsLoaded: false,
                    skipAuxReloadOnce: false,
                    pageSize: DEFAULT_PAGE_SIZE,
                    pageHeight: initialRoute.name === "home" ? coerceInteger(initialRoute.query.height) : null,
                    gotoHeight: initialRoute.name === "home" && initialRoute.query.height ? String(initialRoute.query.height) : "",
                    hasOlder: false,
                    hasNewer: false
                },
                blockView: { loading: false, error: "", block: null, nextHash: "" },
                txView: { loading: false, error: "", tx: null },
                paymentView: { loading: false, error: "", txs: [] },
                addressView: { loading: false, error: "", result: null },
                nodesView: { loading: false, error: "", items: [], summary: null },
                altView: { loading: false, error: "", items: [] },
                settings: {
                    selectedNode: initialApi,
                    customNode: configuredApis.indexOf(initialApi) !== -1 && (window.apiList || []).map(normalizeApiUrl).indexOf(initialApi) === -1 ? initialApi : ""
                },
                broadcastTool: {
                    txHex: "",
                    loading: false,
                    error: "",
                    success: ""
                },
                reserveTool: {
                    address: "",
                    message: "",
                    signature: "",
                    height: "",
                    loading: false,
                    error: "",
                    result: null
                },
                paymentCheckTool: {
                    txHash: "",
                    keyType: "tx_key",
                    secret: "",
                    address: "",
                    loading: false,
                    error: "",
                    result: null,
                    txInfo: null
                },
                validateTool: {
                    address: "",
                    loading: false,
                    error: "",
                    result: null
                },
                verifyMessageTool: {
                    address: "",
                    signature: "",
                    message: "",
                    loading: false,
                    error: "",
                    result: null
                },
                amountTool: {
                    atomic: "",
                    human: ""
                },
                paymentIdTool: {
                    paymentId: "",
                    memo: ""
                },
                paperWallet: {
                    loading: false,
                    error: "",
                    wallet: null
                },
                charts: {
                    difficulty: null
                },
                activeTxTab: "outputs",
                txVerifier: {
                    keyType: "tx_key",
                    secret: "",
                    address: "",
                    loading: false,
                    error: "",
                    result: null
                }
            };
        },
        computed: {
            statsStatusText: function () {
                if (this.statsStatus === "online") return "Live";
                if (this.statsStatus === "warning") return "Stale";
                if (this.statsStatus === "offline") return "Offline";
                return "Connecting";
            },
            statsFreshnessText: function () {
                if (!this.lastStatsFetchedAt) return "Waiting for node telemetry.";
                var age = Math.max(this.nowSeconds - this.lastStatsFetchedAt, 0);
                return "Updated ".concat(this.formatDuration(age), " ago");
            },
            blockDepth: function () {
                if (!this.blockView.block) return "--";
                var explicitDepth = coerceInteger(this.blockView.block.depth);
                if (explicitDepth !== null) return this.formatNumber(explicitDepth);
                var chainHeight = this.getChainHeight();
                var blockHeight = coerceInteger(this.blockView.block.index);
                if (chainHeight === null || blockHeight === null) return "--";
                return this.formatNumber(Math.max(chainHeight - blockHeight, 0));
            },
            transactionConfirmations: function () {
                if (!this.txView.tx || !this.txView.tx.inBlockchain) return 0;
                var chainHeight = this.getChainHeight();
                var blockHeight = coerceInteger(this.txView.tx.blockIndex);
                if (chainHeight === null || blockHeight === null) return 0;
                return Math.max(chainHeight - blockHeight, 0);
            },
            txFeeText: function () {
                if (!this.txView.tx) return "--";
                if (this.txView.tx.inputs && this.txView.tx.inputs[0] && this.txView.tx.inputs[0].type === "ff") return "Coinbase";
                return this.formatCoins(this.txView.tx.fee, 12);
            },
            transactionPaymentId: function () {
                if (!this.txView.tx || !this.txView.tx.paymentId) return "";
                var paymentId = normalizeHex(this.txView.tx.paymentId);
                return /^0+$/.test(paymentId) ? "" : paymentId;
            },
            transactionDecodedPaymentId: function () {
                return this.transactionPaymentId ? hexToAscii(this.transactionPaymentId) : "";
            },
            transactionExtraNonce: function () {
                if (!this.txView.tx || !this.txView.tx.extra || this.txView.tx.extra.nonce === undefined || this.txView.tx.extra.nonce === null) return "";
                return typeof this.txView.tx.extra.nonce === "string" ? this.txView.tx.extra.nonce : bytesToHex(this.txView.tx.extra.nonce);
            },
            transactionDecodedExtraNonce: function () {
                var nonce = this.transactionExtraNonce;
                return nonce ? hexToAscii(nonce) : "";
            },
            averageAlgoHashrate: function () {
                var currentHeight = coerceInteger(this.stats && this.stats.height);
                var cumulativeDifficulty = toBigIntValue(this.stats && (this.stats.cumulative_difficulty !== undefined
                    ? this.stats.cumulative_difficulty
                    : this.stats.cumulativeDifficulty));
                if (this.blockTargetInterval <= 0
                    || AVG_HASHRATE_BASELINE_HEIGHT === null
                    || AVG_HASHRATE_BASELINE_CUMULATIVE_DIFFICULTY === null
                    || currentHeight === null
                    || currentHeight <= AVG_HASHRATE_BASELINE_HEIGHT
                    || cumulativeDifficulty === null
                    || cumulativeDifficulty <= AVG_HASHRATE_BASELINE_CUMULATIVE_DIFFICULTY) {
                    return null;
                }

                var heightSpan = currentHeight - AVG_HASHRATE_BASELINE_HEIGHT;
                if (heightSpan <= 0) return null;

                var cumulativeSpan = cumulativeDifficulty - AVG_HASHRATE_BASELINE_CUMULATIVE_DIFFICULTY;
                var averageHashrate = Number(cumulativeSpan) / heightSpan / this.blockTargetInterval;
                return Number.isFinite(averageHashrate) && averageHashrate > 0 ? averageHashrate : null;
            },
            difficultyChart: function () {
                var blocks = this.home.blocks.slice().reverse();
                if (!blocks.length) {
                    return null;
                }
                var points = blocks.map(function (block) {
                    var height = coerceInteger(block.height) || 0;
                    var timestamp = coerceInteger(block.timestamp) || 0;
                    var chartTimestamp = timestamp > 0 ? timestamp : 1464595200;
                    return {
                        height: height,
                        timestamp: timestamp,
                        chartTimestamp: chartTimestamp,
                        chartTime: new Date(chartTimestamp * 1000).toISOString(),
                        label: timestamp > 0
                            ? formatEnglishLocalDate(timestamp, { hour: "2-digit", minute: "2-digit", hour12: false })
                            : "Genesis",
                        dateTime: timestamp > 0 ? this.formatDateTime(timestamp) : "Genesis block",
                        difficulty: Number(block.difficulty || 0),
                        txCount: coerceInteger(block.transactions_count) || 0,
                        size: coerceInteger(block.cumulative_size) || 0,
                        lapse: coerceInteger(block.lapse) || 0
                    };
                }, this);
                var difficulties = points.map(function (point) { return point.difficulty; });
                var txCounts = points.map(function (point) { return point.txCount; });
                var sizes = points.map(function (point) { return point.size; });
                var lapses = points.map(function (point) { return point.lapse; }).filter(function (value) { return value > 0; });

                return {
                    points: points,
                    labels: points.map(function (point) { return point.chartTime; }),
                    latest: difficulties[difficulties.length - 1] || 0,
                    average: average(difficulties),
                    averageTxCount: average(txCounts),
                    averageSize: average(sizes),
                    averageLapse: lapses.length ? average(lapses) : 0,
                    averageHashrate: this.blockTargetInterval > 0 ? average(difficulties) / this.blockTargetInterval : 0,
                    firstHeight: points[0].height,
                    lastHeight: points[points.length - 1].height
                };
            },
            toolCards: function () {
                return this.toolNav;
            },
            availableApiOptions: function () {
                return unique([this.api, this.settings.customNode].concat(window.apiList || []).map(normalizeApiUrl).filter(Boolean));
            }
        },
        methods: {
            syncMobileHeaderViewport: function () {
                this.isCompactViewport = window.innerWidth <= 760;
                if (!this.isCompactViewport) this.isMobileHeaderHidden = false;
                this.mobileHeaderLastScrollY = Math.max(window.scrollY || window.pageYOffset || 0, 0);
            },
            updateMobileHeaderVisibility: function () {
                var currentScrollY = Math.max(window.scrollY || window.pageYOffset || 0, 0);
                if (!this.isCompactViewport) {
                    this.isMobileHeaderHidden = false;
                    this.mobileHeaderLastScrollY = currentScrollY;
                    return;
                }

                var delta = currentScrollY - this.mobileHeaderLastScrollY;
                if (currentScrollY <= 20) {
                    this.isMobileHeaderHidden = false;
                } else if (delta > 8) {
                    this.isMobileHeaderHidden = true;
                } else if (delta < -8) {
                    this.isMobileHeaderHidden = false;
                }

                this.mobileHeaderLastScrollY = currentScrollY;
            },
            requestMobileHeaderUpdate: function () {
                var _this = this;
                if (this.mobileHeaderTicking) return;
                this.mobileHeaderTicking = true;
                window.requestAnimationFrame(function () {
                    _this.mobileHeaderTicking = false;
                    _this.updateMobileHeaderVisibility();
                });
            },
            isPrimaryActive: function (routeName) {
                if (routeName === "tools") {
                    return this.route.name === "tools" || this.toolNav.some(function (item) { return item.name === this.route.name; }, this);
                }

                return this.route.name === routeName;
            },
            nodeLabel: function (url) {
                try {
                    var parsed = new URL(url);
                    return parsed.port ? "".concat(parsed.hostname, ":").concat(parsed.port) : parsed.hostname;
                } catch (error) {
                    return url || "Unknown node";
                }
            },
            hasDisplayableSignature: function (signature) {
                var normalized = normalizeHex(signature);
                return Boolean(normalized) && !/^0+$/.test(normalized);
            },
            displayBlockSignature: function (signature) {
                return this.hasDisplayableSignature(signature) ? String(signature) : "\u2014";
            },
            linkTo: function (route) {
                return buildRouteUrl(route);
            },
            getTipHeight: function () {
                var candidates = [];
                var lastKnown = coerceInteger(this.stats && this.stats.last_known_block_index);
                var chainHeight = coerceInteger(this.stats && this.stats.height);
                var topFromHome = this.home.blocks.length ? coerceInteger(this.home.blocks[0].height) : null;
                if (lastKnown !== null) candidates.push(lastKnown);
                if (chainHeight !== null) candidates.push(Math.max(chainHeight - 1, 0));
                if (topFromHome !== null) candidates.push(topFromHome);
                return candidates.length ? Math.max.apply(Math, candidates) : null;
            },
            getChainHeight: function () {
                var height = coerceInteger(this.stats && this.stats.height);
                if (height !== null) return height;
                var tipHeight = this.getTipHeight();
                return tipHeight === null ? null : tipHeight + 1;
            },
            formatNumber: function (value) {
                return formatCountValue(value);
            },
            formatCoins: function (value, precision, includeSymbol) {
                var normalizedPrecision = precision;
                var normalizedIncludeSymbol = includeSymbol;
                if (typeof precision === "boolean" && includeSymbol === undefined) {
                    normalizedPrecision = undefined;
                    normalizedIncludeSymbol = precision;
                }
                return renderAtomicCoins(value, normalizedPrecision, normalizedIncludeSymbol, true);
            },
            formatBytes: function (value) {
                var numeric = Number(value);
                if (!Number.isFinite(numeric)) return "--";
                if (numeric < 1024) return "".concat(this.formatNumber(Math.trunc(numeric)), " B");
                var units = ["KB", "MB", "GB", "TB"];
                var amount = numeric;
                var unitIndex = -1;
                do {
                    amount /= 1024;
                    unitIndex += 1;
                } while (amount >= 1024 && unitIndex < units.length - 1);
                return "".concat(amount.toFixed(amount >= 100 ? 0 : amount >= 10 ? 1 : 2).replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1"), " ").concat(units[unitIndex]);
            },
            formatDifficulty: function (value) {
                return this.formatNumber(value);
            },
            formatHashrate: function (value) {
                var numeric = Number(value);
                if (!Number.isFinite(numeric)) return "--";
                var units = ["H/s", "kH/s", "MH/s", "GH/s", "TH/s", "PH/s"];
                var amount = numeric;
                var unitIndex = 0;
                while (amount >= 1000 && unitIndex < units.length - 1) {
                    amount /= 1000;
                    unitIndex += 1;
                }
                return "".concat(amount.toFixed(amount >= 100 ? 0 : amount >= 10 ? 1 : 2).replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1"), " ").concat(units[unitIndex]);
            },
            formatDateTime: function (seconds) {
                return formatEnglishLocalDate(seconds, {
                    year: "numeric",
                    month: "short",
                    day: "2-digit",
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                    hour12: false
                });
            },
            formatRelativeTime: function (seconds) {
                var numeric = Number(seconds);
                if (!Number.isFinite(numeric) || numeric <= 0) return "--";
                var delta = Math.trunc(this.nowSeconds - numeric);
                var absolute = Math.abs(delta);
                if (absolute < 5) return "just now";
                if (absolute < 60) return delta >= 0 ? "".concat(absolute, "s ago") : "in ".concat(absolute, "s");
                if (absolute < 3600) return delta >= 0 ? "".concat(Math.floor(absolute / 60), "m ago") : "in ".concat(Math.floor(absolute / 60), "m");
                if (absolute < 86400) return delta >= 0 ? "".concat(Math.floor(absolute / 3600), "h ago") : "in ".concat(Math.floor(absolute / 3600), "h");
                return delta >= 0 ? "".concat(Math.floor(absolute / 86400), "d ago") : "in ".concat(Math.floor(absolute / 86400), "d");
            },
            formatDuration: function (seconds) {
                var numeric = Number(seconds);
                if (!Number.isFinite(numeric) || numeric < 0) return "0s";
                if (numeric < 60) return "".concat(Math.floor(numeric), "s");
                if (numeric < 3600) return "".concat(Math.floor(numeric / 60), "m ").concat(Math.floor(numeric % 60), "s");
                if (numeric < 86400) return "".concat(Math.floor(numeric / 3600), "h ").concat(Math.floor((numeric % 3600) / 60), "m");
                return "".concat(Math.floor(numeric / 86400), "d ").concat(Math.floor((numeric % 86400) / 3600), "h");
            },
            formatPercent: function (value) {
                var numeric = Number(value);
                if (!Number.isFinite(numeric)) return "--";
                var percent = Math.abs(numeric) <= 1 ? numeric * 100 : numeric;
                return "".concat(percent.toFixed(percent % 1 === 0 ? 0 : 2).replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1"), "%");
            },
            scheduleDifficultyChartRender: function () {
                var _this = this;
                this.$nextTick(function () {
                    _this.renderDifficultyChart();
                });
            },
            destroyDifficultyChart: function () {
                if (this.charts.difficulty && typeof this.charts.difficulty.destroy === "function") {
                    this.charts.difficulty.destroy();
                }
                this.charts.difficulty = null;
            },
            renderDifficultyChart: async function () {
                var _this = this;
                if (this.route.name !== "home") {
                    this.destroyDifficultyChart();
                    return;
                }

                var model = this.difficultyChart;
                var canvas = this.$refs.difficultyCanvas;
                if (!model || !canvas) {
                    this.destroyDifficultyChart();
                    return;
                }

                try {
                    if (!window.moment) await loadScriptOnce("/js/moment.min.js");
                    if (!window.Chart) await loadScriptOnce("/js/Chart.bundle.min.js");
                } catch (error) {
                    this.destroyDifficultyChart();
                    this.showToast("Could not load the chart library.", "error");
                    return;
                }

                if (!window.Chart) return;

                this.destroyDifficultyChart();

                var styles = window.getComputedStyle(document.documentElement);
                var primary = styles.getPropertyValue("--primary").trim() || "#5ca2ff";
                var lineColor = styles.getPropertyValue("--line").trim() || "rgba(137, 175, 255, 0.16)";
                var lineStrong = styles.getPropertyValue("--line-strong").trim() || "rgba(137, 175, 255, 0.24)";
                var textColor = styles.getPropertyValue("--text").trim() || "#edf4ff";
                var textMuted = styles.getPropertyValue("--text-muted").trim() || "#9fb2ca";
                var textSoft = styles.getPropertyValue("--text-soft").trim() || "#7f93ac";
                var backgroundStrong = styles.getPropertyValue("--bg-card-strong").trim() || "rgba(17, 29, 48, 0.96)";
                var context = canvas.getContext("2d");
                if (!context) return;

                this.charts.difficulty = new window.Chart(context, {
                    type: "line",
                    data: {
                        labels: model.labels,
                        datasets: [
                            {
                                label: "Network difficulty",
                                yAxisID: "difficulty",
                                data: model.points.map(function (point) {
                                    return {
                                        x: point.chartTime,
                                        y: point.difficulty
                                    };
                                }),
                                borderColor: primary,
                                backgroundColor: primary,
                                borderWidth: 3,
                                pointRadius: 2,
                                pointHoverRadius: 4,
                                pointHitRadius: 8,
                                fill: false
                            }
                        ]
                    },
                    options: {
                        animation: {
                            duration: 0
                        },
                        responsive: true,
                        maintainAspectRatio: false,
                        legend: {
                            display: false,
                            position: "top",
                            labels: {
                                boxWidth: 10,
                                fontColor: textMuted,
                                padding: 18
                            }
                        },
                        elements: {
                            line: {
                                tension: 0
                            }
                        },
                        scales: {
                            xAxes: [
                                {
                                    type: "time",
                                    time: {
                                        parser: false,
                                        unit: "minute",
                                        unitStepSize: 60,
                                        round: "second",
                                        displayFormats: {
                                            millisecond: "SSS [ms]",
                                            second: "HH:mm:ss",
                                            minute: "HH:mm",
                                            hour: "HH:mm",
                                            day: "MMM D",
                                            week: "ll",
                                            month: "MMM YYYY",
                                            quarter: "[Q]Q - YYYY",
                                            year: "YYYY"
                                        }
                                    },
                                    gridLines: {
                                        color: lineColor,
                                        display: false,
                                        drawBorder: false
                                    },
                                    ticks: {
                                        autoSkip: true,
                                        fontColor: textSoft,
                                        maxRotation: 0,
                                        maxTicksLimit: 8,
                                        minRotation: 0
                                    }
                                }
                            ],
                            yAxes: [
                                {
                                    id: "difficulty",
                                    type: "linear",
                                    position: "left",
                                    gridLines: {
                                        color: lineColor,
                                        drawBorder: false
                                    },
                                    ticks: {
                                        beginAtZero: false,
                                        fontColor: textMuted,
                                        callback: function (value) {
                                            return _this.formatDifficulty(value);
                                        }
                                    },
                                    scaleLabel: {
                                        display: true,
                                        fontColor: textSoft,
                                        labelString: "Difficulty"
                                    }
                                }
                            ]
                        },
                        tooltips: {
                            mode: "index",
                            intersect: false,
                            backgroundColor: backgroundStrong,
                            titleFontColor: textColor,
                            bodyFontColor: textColor,
                            footerFontColor: textMuted,
                            xPadding: 10,
                            yPadding: 10,
                            cornerRadius: 10,
                            caretPadding: 8,
                            multiKeyBackground: lineStrong,
                            callbacks: {
                                title: function (items) {
                                    var point = model.points[items[0].index];
                                    return "Block " + _this.formatNumber(point.height);
                                },
                                afterTitle: function (items) {
                                    var point = model.points[items[0].index];
                                    return point.dateTime;
                                },
                                label: function (tooltipItem) {
                                    var point = model.points[tooltipItem.index];
                                    return [
                                        "Difficulty: " + _this.formatDifficulty(point.difficulty),
                                        "Transactions: " + _this.formatNumber(point.txCount),
                                        "Block size: " + _this.formatBytes(point.size)
                                    ];
                                },
                                footer: function (items) {
                                    var point = model.points[items[0].index];
                                    return [
                                        "Solve time: " + _this.formatDuration(point.lapse),
                                        "Click to open /block/" + point.height
                                    ];
                                }
                            }
                        },
                        hover: {
                            mode: "nearest",
                            intersect: false,
                            onHover: function (event, activeItems) {
                                canvas.style.cursor = activeItems && activeItems.length ? "pointer" : "default";
                            }
                        },
                        onClick: function (event, activeItems) {
                            if (!activeItems || !activeItems.length) return;
                            var active = activeItems[0];
                            var index = active._index !== undefined ? active._index : active.index;
                            var point = model.points[index];
                            if (!point) return;
                            _this.goTo({ name: "block", params: { hash: String(point.height) } });
                        }
                    }
                });
            },
            applyTheme: function () {
                document.documentElement.setAttribute("data-theme", this.theme);
            },
            setTheme: function (theme) {
                this.theme = theme === "light" ? "light" : "dark";
                safeStorageSet(STORAGE_THEME_KEY, this.theme);
                this.applyTheme();
                if (this.route.name === "home") this.scheduleDifficultyChartRender();
            },
            toggleTheme: function () {
                this.setTheme(this.theme === "dark" ? "light" : "dark");
            },
            showToast: function (message, tone) {
                var _this = this;
                this.toast = { message: message, tone: tone || "info" };
                if (this.toastTimerId) window.clearTimeout(this.toastTimerId);
                this.toastTimerId = window.setTimeout(function () {
                    _this.toast = null;
                    _this.toastTimerId = 0;
                }, 3200);
            },
            copyText: async function (text, successMessage) {
                if (!text) return;
                try {
                    if (navigator.clipboard && navigator.clipboard.writeText) {
                        await navigator.clipboard.writeText(text);
                    } else {
                        var input = document.createElement("textarea");
                        input.value = text;
                        input.setAttribute("readonly", "readonly");
                        input.style.position = "absolute";
                        input.style.left = "-9999px";
                        document.body.appendChild(input);
                        input.select();
                        document.execCommand("copy");
                        document.body.removeChild(input);
                    }
                    this.showToast(successMessage || "Copied to clipboard.", "success");
                } catch (error) {
                    this.showToast("Clipboard copy failed.", "error");
                }
            },
            loadStats: async function (options) {
                var opts = options || {};
                var allowFallback = Boolean(opts.allowFallback);
                var silent = Boolean(opts.silent);
                var candidates = allowFallback ? unique([this.api].concat(window.apiList || []).map(normalizeApiUrl).filter(Boolean)) : [this.api];
                var lastError = null;
                if (!candidates.length || !candidates[0]) throw new Error("No RPC endpoint configured.");
                if (!this.stats) this.statsStatus = "loading";
                for (var candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
                    var candidate = candidates[candidateIndex];
                    try {
                        var info = await fetchNodeInfo(candidate);
                        this.stats = info;
                        this.statsStatus = "online";
                        this.lastStatsFetchedAt = Math.floor(Date.now() / 1000);
                        if (candidate !== this.api) {
                            this.api = candidate;
                            this.settings.selectedNode = candidate;
                            safeStorageSet(STORAGE_API_KEY, candidate);
                            if (!silent) this.showToast("Switched to a responding public node.", "info");
                        }
                        return info;
                    } catch (error) {
                        lastError = error;
                    }
                }
                this.statsStatus = this.stats ? "warning" : "offline";
                if (!silent) this.showToast(readableError(lastError, "Could not reach the connected node."), "error");
                throw lastError || new Error("Could not reach the connected node.");
            },
            ensureStats: async function () {
                return this.stats || this.loadStats({ allowFallback: true, silent: true });
            },
            goTo: async function (route, options) {
                var normalized = normalizeRoute(route);
                var url = buildRouteUrl(normalized);
                var replace = options && options.replace;
                var scrollTop = !options || options.scrollTop !== false;
                if (url === window.location.pathname + window.location.search) {
                    this.route = normalized;
                    this.isMobileHeaderHidden = false;
                    await this.loadRouteData();
                    return;
                }
                if (replace) window.history.replaceState(null, "", url); else window.history.pushState(null, "", url);
                this.route = normalized;
                this.isMobileHeaderHidden = false;
                if (scrollTop) window.scrollTo(0, 0);
                await this.loadRouteData();
            },
            onPopState: async function () {
                this.route = parseCurrentRoute(window.location);
                this.isMobileHeaderHidden = false;
                await this.loadRouteData();
            },
            loadRouteData: async function (options) {
                var opts = options || {};
                var token = ++this.routeRequestId;
                if (this.route.name === "home") {
                    if (this.route.query.height !== undefined) this.home.pageHeight = coerceInteger(this.route.query.height);
                    return this.loadHomeData(token, opts.background);
                }
                this.destroyDifficultyChart();
                if (this.route.name === "block") return this.loadBlockData(token, opts.background);
                if (this.route.name === "transaction") return this.loadTransactionData(token, opts.background);
                if (this.route.name === "payment-id") return this.loadPaymentData(token, opts.background);
                if (this.route.name === "address") return this.loadAddressData(token, opts.background);
                if (this.route.name === "nodes") return this.loadNodesData(token, opts.background);
                if (this.route.name === "alt-blocks") return this.loadAltBlocksData(token, opts.background);
                return true;
            },
            loadHomeData: async function (token, background) {
                if (!background || !this.home.blocks.length) this.home.loading = true;
                this.home.error = "";
                try {
                    var skipAuxReload = this.home.skipAuxReloadOnce;
                    var skipMempoolReload = skipAuxReload && this.home.mempoolLoaded;
                    var skipRecentTransactionsReload = skipAuxReload && this.home.recentTransactionsLoaded;
                    this.home.skipAuxReloadOnce = false;
                    await this.ensureStats();
                    if (token !== this.routeRequestId) return false;
                    var tipHeight = this.getTipHeight();
                    var targetHeight = this.home.pageHeight;
                    if (targetHeight === null || targetHeight === undefined) targetHeight = tipHeight;
                    if (tipHeight !== null) targetHeight = Math.min(targetHeight, tipHeight);
                    targetHeight = Math.max(coerceInteger(targetHeight) || 0, 0);
                    var requests = [
                        rpcCall(this.api, "getblockslist", { count: this.home.pageSize + 1, height: targetHeight })
                    ];
                    if (!skipMempoolReload) requests.push(rpcCall(this.api, "gettransactionspool", {}));
                    var results = await Promise.all(requests);
                    if (token !== this.routeRequestId) return false;
                    var blocks = sortBlocksDescending(results[0].blocks || []);
                    var fetchedBlocks = blocks.slice(0, this.home.pageSize).map(function (block) {
                        return Object.assign({}, block);
                    });
                    var tailBlock = blocks[fetchedBlocks.length] ? Object.assign({}, blocks[fetchedBlocks.length]) : null;
                    var existingNewestHeight = this.home.blocks.length ? coerceInteger(this.home.blocks[0].height) : null;
                    var fetchedOldestHeight = fetchedBlocks.length ? coerceInteger(fetchedBlocks[fetchedBlocks.length - 1].height) : null;
                    var hasContiguousTipWindow = existingNewestHeight !== null
                        && fetchedOldestHeight !== null
                        && fetchedOldestHeight <= existingNewestHeight + 1;
                    var preserveLoadedBlocks = this.home.blocks.length
                        && tipHeight !== null
                        && targetHeight === tipHeight
                        && !this.home.hasNewer
                        && hasContiguousTipWindow;
                    var displayedBlocks = preserveLoadedBlocks
                        ? decorateHomeBlocks(fetchedBlocks.concat(this.home.blocks))
                        : decorateHomeBlocks(fetchedBlocks, tailBlock);
                    this.home.blocks = displayedBlocks;
                    if (!skipMempoolReload) {
                        var mempoolResult = results[1] || {};
                        var mempool = (mempoolResult.transactions || []).slice().sort(function (left, right) {
                            return (coerceInteger(right.receive_time) || 0) - (coerceInteger(left.receive_time) || 0);
                        });
                        this.home.mempool = mempool;
                        this.home.mempoolLoaded = true;
                    }
                    this.home.pageHeight = displayedBlocks.length ? coerceInteger(displayedBlocks[0].height) : targetHeight;
                    this.home.gotoHeight = this.home.pageHeight !== null && this.home.pageHeight !== undefined ? String(this.home.pageHeight) : "";
                    this.home.hasOlder = displayedBlocks.length ? (coerceInteger(displayedBlocks[displayedBlocks.length - 1].height) || 0) > 0 : false;
                    this.home.hasNewer = displayedBlocks.length && tipHeight !== null ? (coerceInteger(displayedBlocks[0].height) || 0) < tipHeight : false;
                    if (!skipRecentTransactionsReload) await this.loadRecentTransactions(token, displayedBlocks, background);
                    this.home.loading = false;
                    this.home.loadingMore = false;
                    this.scheduleDifficultyChartRender();
                    return true;
                } catch (error) {
                    if (token === this.routeRequestId) {
                        this.home.error = readableError(error, "Could not load latest blocks.");
                        this.home.loading = false;
                        this.home.loadingMore = false;
                        this.scheduleDifficultyChartRender();
                    }
                    return false;
                }
            },
            loadRecentTransactions: async function (token, blocks, background) {
                var limit = RECENT_CONFIRMED_TX_LIMIT;
                var batchSize = RECENT_CONFIRMED_TX_SCAN_BATCH;
                var newestVisibleHeight = blocks && blocks.length ? coerceInteger(blocks[0].height) : this.getTipHeight();

                if (!background || !this.home.recentTransactions.length) this.home.recentTransactionsLoading = true;
                this.home.recentTransactionsError = "";

                if (newestVisibleHeight === null || newestVisibleHeight < 0) {
                    if (token !== this.routeRequestId) return;
                    this.home.recentTransactions = [];
                    this.home.recentTransactionsLoaded = true;
                    this.home.recentTransactionsLoading = false;
                    return;
                }

                try {
                    var rangeStart = null;
                    var rangeEnd = null;
                    var nextHeight = newestVisibleHeight;

                    while (nextHeight >= 0) {
                        var blockListResult = await rpcCall(this.api, "getblockslist", {
                            count: batchSize,
                            height: nextHeight
                        });
                        if (token !== this.routeRequestId) return;
                        var extraBlocks = sortBlocksDescending(blockListResult.blocks || []).slice(0, batchSize);
                        if (!extraBlocks.length) break;
                        var confirmedCount = extraBlocks.reduce(function (sum, block) {
                            return sum + Math.max((coerceInteger(block.transactions_count) || 0) - 1, 0);
                        }, 0);
                        if (confirmedCount > 0) {
                            rangeEnd = coerceInteger(extraBlocks[0].height);
                            rangeStart = coerceInteger(extraBlocks[extraBlocks.length - 1].height);
                            break;
                        }
                        var oldestHeight = coerceInteger(extraBlocks[extraBlocks.length - 1].height);
                        if (oldestHeight === null || oldestHeight <= 0) break;
                        nextHeight = oldestHeight - 1;
                    }

                    if (rangeStart === null || rangeEnd === null) {
                        if (token !== this.routeRequestId) return;
                        this.home.recentTransactions = [];
                        this.home.recentTransactionsLoaded = true;
                        return;
                    }

                    var result = await rpcCall(this.api, "gettransactionsbyheights", {
                        heights: [rangeStart, rangeEnd + 1],
                        include_miner_txs: false,
                        exclude_signatures: true,
                        range: true
                    });
                    var transactions = (result.transactions || []).slice().sort(function (left, right) {
                        var leftHeight = coerceInteger(left.blockIndex) || 0;
                        var rightHeight = coerceInteger(right.blockIndex) || 0;
                        if (leftHeight !== rightHeight) return rightHeight - leftHeight;
                        var leftTimestamp = coerceInteger(left.timestamp) || 0;
                        var rightTimestamp = coerceInteger(right.timestamp) || 0;
                        if (leftTimestamp !== rightTimestamp) return rightTimestamp - leftTimestamp;
                        return String(left.hash || "").localeCompare(String(right.hash || ""));
                    });
                    if (token !== this.routeRequestId) return;
                    this.home.recentTransactions = transactions.slice(0, limit);
                    this.home.recentTransactionsLoaded = true;
                } catch (error) {
                    if (token !== this.routeRequestId) return;
                    this.home.recentTransactionsError = readableError(error, "Could not load recent confirmed transactions.");
                    if (!background || !this.home.recentTransactions.length) this.home.recentTransactions = [];
                    this.home.recentTransactionsLoaded = false;
                } finally {
                    if (token !== this.routeRequestId) return;
                    this.home.recentTransactionsLoading = false;
                }
            },
            loadBlockData: async function (token, background) {
                if (!background || !this.blockView.block) this.blockView.loading = true;
                this.blockView.error = "";
                try {
                    this.ensureStats().catch(function () { return null; });
                    var blockIdentifier = String(this.route.params.hash || "").trim();
                    var blockHash = blockIdentifier;
                    if (/^\d+$/.test(blockIdentifier)) {
                        var headerByHeight = await rpcCall(this.api, "getblockheaderbyheight", {
                            height: parseInt(blockIdentifier, 10)
                        });
                        blockHash = headerByHeight && headerByHeight.block_header && headerByHeight.block_header.hash
                            ? headerByHeight.block_header.hash
                            : "";
                        if (!blockHash) throw new Error("Block height was not found.");
                    }
                    var result = await rpcCall(this.api, "getblockbyhash", { hash: blockHash });
                    var block = result.block ? result.block : result;
                    var nextHash = "";
                    try {
                        var nextHeader = await rpcCall(this.api, "getblockheaderbyheight", { height: (coerceInteger(block.index) || 0) + 1 });
                        nextHash = nextHeader.block_header && nextHeader.block_header.hash ? nextHeader.block_header.hash : "";
                    } catch (nextError) {
                        nextHash = "";
                    }
                    if (token !== this.routeRequestId) return false;
                    block.transactions = Array.isArray(block.transactions) ? block.transactions : [];
                    this.blockView.block = block;
                    this.blockView.nextHash = nextHash;
                    this.blockView.loading = false;
                    return true;
                } catch (error) {
                    if (token === this.routeRequestId) {
                        this.blockView.error = readableError(error, "Could not load block details.");
                        this.blockView.block = null;
                        this.blockView.nextHash = "";
                        this.blockView.loading = false;
                    }
                    return false;
                }
            },
            loadTransactionData: async function (token, background) {
                if (!background || !this.txView.tx) this.txView.loading = true;
                this.txView.error = "";
                try {
                    this.ensureStats().catch(function () { return null; });
                    var result = await rpcCall(this.api, "gettransaction", { hash: this.route.params.hash });
                    if (token !== this.routeRequestId) return false;
                    var transaction = result.transaction ? result.transaction : result;
                    transaction.inputs = Array.isArray(transaction.inputs) ? transaction.inputs : [];
                    transaction.outputs = Array.isArray(transaction.outputs) ? transaction.outputs : [];
                    transaction.signatures = Array.isArray(transaction.signatures) ? transaction.signatures : [];
                    transaction.extra = transaction.extra && typeof transaction.extra === "object" ? transaction.extra : {};
                    this.txView.tx = transaction;
                    this.txView.loading = false;
                    this.activeTxTab = "outputs";
                    this.txVerifier.loading = false;
                    this.txVerifier.error = "";
                    this.txVerifier.result = null;
                    return true;
                } catch (error) {
                    if (token === this.routeRequestId) {
                        this.txView.error = readableError(error, "Could not load transaction details.");
                        this.txView.tx = null;
                        this.txView.loading = false;
                    }
                    return false;
                }
            },
            loadPaymentData: async function (token, background) {
                if (!background || !this.paymentView.txs.length) this.paymentView.loading = true;
                this.paymentView.error = "";
                try {
                    var result = await rpcCall(this.api, "gettransactionsbypaymentid", { payment_id: this.route.params.hash });
                    if (token !== this.routeRequestId) return false;
                    this.paymentView.txs = (result.transactions || []).slice().sort(function (left, right) {
                        return (coerceInteger(right.timestamp || right.receive_time) || 0) - (coerceInteger(left.timestamp || left.receive_time) || 0);
                    });
                    this.paymentView.loading = false;
                    return true;
                } catch (error) {
                    if (token === this.routeRequestId) {
                        this.paymentView.error = readableError(error, "Could not load transactions for that payment ID.");
                        this.paymentView.txs = [];
                        this.paymentView.loading = false;
                    }
                    return false;
                }
            },
            loadAddressData: async function (token, background) {
                if (!background || !this.addressView.result) this.addressView.loading = true;
                this.addressView.error = "";
                try {
                    var result = await rpcCall(this.api, "validateaddress", { address: this.route.params.address });
                    if (token !== this.routeRequestId) return false;
                    this.addressView.result = {
                        isValid: coerceBoolean(result.is_valid),
                        viewPublicKey: result.view_public_key || "",
                        spendPublicKey: result.spend_public_key || ""
                    };
                    this.addressView.loading = false;
                    return true;
                } catch (error) {
                    if (token === this.routeRequestId) {
                        this.addressView.error = readableError(error, "Could not validate that address.");
                        this.addressView.result = null;
                        this.addressView.loading = false;
                    }
                    return false;
                }
            },
            formatNodeFeeText: function (feeData) {
                if (!feeData) return "free";
                if (feeData.fee_amount !== undefined && feeData.fee_amount !== null && Number(feeData.fee_amount) > 0) {
                    return "".concat(this.formatCoins(feeData.fee_amount, 12, false), " ").concat(String(window.symbol || "KRB"));
                }
                if (feeData.fee_address) return "0.25%";
                return "free";
            },
            loadNodesData: async function (token, background) {
                var _this2 = this;
                if (!background || !this.nodesView.items.length) this.nodesView.loading = true;
                this.nodesView.error = "";
                try {
                    var listedNodes = await fetchJson("/api/nodes.json", { headers: { Accept: "application/json" } });
                    var urls = unique((listedNodes || []).map(normalizeApiUrl).filter(Boolean));
                    var items = await Promise.all(urls.map(async function (url) {
                        var item = {
                            url: url,
                            name: _this2.nodeLabel(url),
                            online: false,
                            height: null,
                            lastKnownBlockIndex: null,
                            topBlockHash: "",
                            difficulty: null,
                            altBlocksCount: null,
                            rpcConnectionsCount: null,
                            incomingConnectionsCount: null,
                            outgoingConnectionsCount: null,
                            version: "",
                            startTime: null,
                            feeText: "free"
                        };
                        try {
                            var info = await fetchNodeInfo(url);
                            item.online = true;
                            item.height = Math.max((coerceInteger(info.height) || 0) - 1, 0);
                            item.lastKnownBlockIndex = coerceInteger(info.last_known_block_index);
                            item.topBlockHash = info.top_block_hash || "";
                            item.difficulty = info.difficulty;
                            item.altBlocksCount = info.alt_blocks_count;
                            item.rpcConnectionsCount = coerceInteger(info.rpc_connections_count);
                            item.incomingConnectionsCount = coerceInteger(info.incoming_connections_count);
                            item.outgoingConnectionsCount = coerceInteger(info.outgoing_connections_count);
                            item.version = info.version || "";
                            item.startTime = coerceInteger(info.start_time);
                            try {
                                var feeData = await fetchNodeFee(url);
                                item.feeText = _this2.formatNodeFeeText(feeData);
                            } catch (feeError) {
                                item.feeText = "free";
                            }
                        } catch (error) {
                            item.online = false;
                        }
                        return item;
                    }));
                    if (token !== this.routeRequestId) return false;
                    var onlineNodes = items.filter(function (item) { return item.online; });
                    var heights = onlineNodes.map(function (item) { return item.height; }).filter(function (value) { return value !== null; });
                    var hashes = onlineNodes.map(function (item) { return item.topBlockHash; }).filter(Boolean);
                    var difficulties = onlineNodes.map(function (item) { return item.difficulty; }).filter(function (value) { return value !== null && value !== undefined; });
                    var versions = onlineNodes.map(function (item) { return item.version; }).filter(Boolean);
                    var heightSummary = modeSummary(heights);
                    var hashSummary = modeSummary(hashes);
                    var difficultySummary = modeSummary(difficulties);
                    var versionSummary = modeSummary(versions);
                    items.sort(function (left, right) {
                        if (left.online !== right.online) return left.online ? -1 : 1;
                        return (coerceInteger(right.height) || -1) - (coerceInteger(left.height) || -1);
                    });
                    this.nodesView.items = items;
                    this.nodesView.summary = {
                        totalCount: items.length,
                        onlineCount: onlineNodes.length,
                        commonHeight: heightSummary.value,
                        commonHeightCount: heightSummary.count,
                        commonHash: hashSummary.value,
                        commonHashCount: hashSummary.count,
                        commonDifficulty: difficultySummary.value,
                        commonDifficultyCount: difficultySummary.count,
                        commonVersion: versionSummary.value,
                        commonVersionCount: versionSummary.count
                    };
                    this.nodesView.loading = false;
                    return true;
                } catch (error) {
                    if (token === this.routeRequestId) {
                        this.nodesView.error = readableError(error, "Could not load the public node list.");
                        this.nodesView.items = [];
                        this.nodesView.summary = null;
                        this.nodesView.loading = false;
                    }
                    return false;
                }
            },
            loadAltBlocksData: async function (token, background) {
                if (!background || !this.altView.items.length) this.altView.loading = true;
                this.altView.error = "";
                try {
                    var result = await rpcCall(this.api, "getaltblockslist", {});
                    if (token !== this.routeRequestId) return false;
                    this.altView.items = sortBlocksDescending(result.alt_blocks || []);
                    this.altView.loading = false;
                    return true;
                } catch (error) {
                    if (token === this.routeRequestId) {
                        this.altView.error = readableError(error, "Could not load alternative blocks.");
                        this.altView.items = [];
                        this.altView.loading = false;
                    }
                    return false;
                }
            },
            refreshCurrentView: async function () {
                this.pageBusy = true;
                try {
                    await this.loadStats({ allowFallback: true, silent: true });
                    if (this.route.name === "home" && !this.home.hasNewer) this.home.pageHeight = this.getTipHeight();
                    var refreshed = await this.loadRouteData();
                    if (refreshed) this.showToast("View refreshed.", "success");
                } finally {
                    this.pageBusy = false;
                }
            },
            resetHomeBlocks: function (options) {
                var opts = options || {};
                this.home.blocks = [];
                if (!opts.preserveAux) {
                    this.home.mempool = [];
                    this.home.mempoolLoaded = false;
                    this.home.recentTransactions = [];
                    this.home.recentTransactionsError = "";
                    this.home.recentTransactionsLoading = false;
                    this.home.recentTransactionsLoaded = false;
                }
                this.home.hasOlder = false;
                this.home.hasNewer = false;
                this.home.loadingMore = false;
            },
            goToLatestBlocks: async function () {
                var tipHeight = this.getTipHeight();
                if (tipHeight === null || !this.home.hasNewer) return;
                this.home.skipAuxReloadOnce = true;
                this.resetHomeBlocks({ preserveAux: true });
                await this.goTo({ name: "home", query: { height: String(tipHeight) } }, { replace: true, scrollTop: false });
            },
            goToFirstBlocks: async function () {
                this.home.skipAuxReloadOnce = true;
                this.resetHomeBlocks({ preserveAux: true });
                await this.goTo({ name: "home", query: { height: "0" } }, { replace: true, scrollTop: false });
            },
            goToOlderBlocks: async function () {
                if (!this.home.blocks.length) return;
                var oldest = coerceInteger(this.home.blocks[this.home.blocks.length - 1].height);
                if (oldest === null || oldest <= 0) return;
                this.home.skipAuxReloadOnce = true;
                this.resetHomeBlocks({ preserveAux: true });
                await this.goTo({ name: "home", query: { height: String(Math.max(oldest - 1, 0)) } }, { replace: true, scrollTop: false });
            },
            loadMoreBlocks: async function () {
                if (this.home.loadingMore || !this.home.blocks.length) return;
                if (!this.home.blocks.length) return;
                var oldest = coerceInteger(this.home.blocks[this.home.blocks.length - 1].height);
                if (oldest === null || oldest <= 0) return;
                this.home.loadingMore = true;
                this.home.error = "";
                try {
                    await this.ensureStats();
                    var result = await rpcCall(this.api, "getblockslist", {
                        count: this.home.pageSize + 1,
                        height: Math.max(oldest - 1, 0)
                    });
                    var fetchedBlocks = sortBlocksDescending(result.blocks || []).slice(0, this.home.pageSize).map(function (block) {
                        return Object.assign({}, block);
                    });
                    var mergedBlocks = decorateHomeBlocks(this.home.blocks.concat(fetchedBlocks));
                    var tipHeight = this.getTipHeight();
                    this.home.blocks = mergedBlocks;
                    this.home.hasOlder = fetchedBlocks.length > 0 && mergedBlocks.length ? (coerceInteger(mergedBlocks[mergedBlocks.length - 1].height) || 0) > 0 : false;
                    this.home.hasNewer = mergedBlocks.length && tipHeight !== null ? (coerceInteger(mergedBlocks[0].height) || 0) < tipHeight : false;
                    this.scheduleDifficultyChartRender();
                } catch (error) {
                    this.home.error = readableError(error, "Could not load older blocks.");
                } finally {
                    this.home.loadingMore = false;
                }
            },
            goToNewerBlocks: async function () {
                if (!this.home.blocks.length) return;
                var newest = coerceInteger(this.home.blocks[0].height);
                var tipHeight = this.getTipHeight();
                if (newest === null || tipHeight === null) return;
                this.home.skipAuxReloadOnce = true;
                this.resetHomeBlocks({ preserveAux: true });
                await this.goTo({ name: "home", query: { height: String(Math.min(newest + this.home.pageSize, tipHeight)) } }, { replace: true, scrollTop: false });
            },
            reloadHome: async function () {
                var targetHeight = this.home.pageHeight !== null && this.home.pageHeight !== undefined
                    ? this.home.pageHeight
                    : this.getTipHeight();
                this.resetHomeBlocks();
                await this.goTo({ name: "home", query: { height: String(targetHeight || 0) } }, { replace: true, scrollTop: false });
            },
            goToHomeHeight: async function () {
                var targetHeight = coerceInteger(this.home.gotoHeight);
                if (targetHeight === null || targetHeight < 0) {
                    this.showToast("Enter a valid block height.", "error");
                    return;
                }
                this.resetHomeBlocks();
                await this.goTo({ name: "home", query: { height: String(targetHeight) } }, { replace: true, scrollTop: false });
            },
            submitSearch: async function () {
                var query = this.searchQuery.trim();
                if (!query) {
                    this.showToast("Enter a block height, hash, payment ID, or address.", "error");
                    return;
                }
                if (query.length === 95 && ADDRESS_PATTERN.test(query)) {
                    await this.goTo({ name: "address", params: { address: query } });
                    return;
                }
                this.pageBusy = true;
                try {
                    if (/^\d+$/.test(query) && query.length < 64) {
                        await this.goTo({ name: "block", params: { hash: query } });
                        return;
                    }
                    if (isHexString(query, 64)) {
                        try {
                            var blockResult = await rpcCall(this.api, "getblockbyhash", { hash: query });
                            if (blockResult && blockResult.block && blockResult.block.hash) {
                                await this.goTo({ name: "block", params: { hash: blockResult.block.hash } });
                                return;
                            }
                        } catch (blockError) {}
                        try {
                            var txResult = await rpcCall(this.api, "gettransaction", { hash: query });
                            if (txResult && txResult.transaction && txResult.transaction.hash) {
                                await this.goTo({ name: "transaction", params: { hash: txResult.transaction.hash } });
                                return;
                            }
                        } catch (transactionError) {}
                        try {
                            await rpcCall(this.api, "gettransactionsbypaymentid", { payment_id: query });
                            await this.goTo({ name: "payment-id", params: { hash: query } });
                            return;
                        } catch (paymentError) {}
                    }
                    this.showToast("Nothing matched that search.", "error");
                } catch (error) {
                    this.showToast(readableError(error, "Search failed."), "error");
                } finally {
                    this.pageBusy = false;
                }
            },
            broadcastTransactionTool: async function () {
                this.broadcastTool.error = "";
                this.broadcastTool.success = "";
                if (!this.broadcastTool.txHex.trim()) {
                    this.broadcastTool.error = "Paste raw transaction hex first.";
                    return;
                }
                this.broadcastTool.loading = true;
                try {
                    var result = await sendRawTransaction(this.api, this.broadcastTool.txHex.trim());
                    if (result.status === "OK") {
                        this.broadcastTool.success = "Transaction broadcast successfully.";
                    } else if (result.status === "Not relayed") {
                        this.broadcastTool.error = "Transaction was accepted locally but not relayed.";
                    } else {
                        this.broadcastTool.error = "Transaction broadcast failed.";
                    }
                } catch (error) {
                    this.broadcastTool.error = readableError(error, "Transaction broadcast failed.");
                } finally {
                    this.broadcastTool.loading = false;
                }
            },
            checkReserveProofTool: async function () {
                this.reserveTool.error = "";
                this.reserveTool.result = null;
                if (!this.reserveTool.address.trim() || !this.reserveTool.signature.trim()) {
                    this.reserveTool.error = "Address and signature are required.";
                    return;
                }
                this.reserveTool.loading = true;
                try {
                    var height = this.reserveTool.height.trim()
                        ? parseInt(this.reserveTool.height.trim(), 10)
                        : (this.stats ? coerceInteger(this.stats.last_known_block_index) : this.getTipHeight());
                    var result = await rpcCall(this.api, "checkreserveproof", {
                        message: this.reserveTool.message.trim(),
                        address: this.reserveTool.address.trim(),
                        signature: this.reserveTool.signature.trim(),
                        height: height
                    });
                    this.reserveTool.result = {
                        good: coerceBoolean(result.good),
                        total: result.total,
                        spent: result.spent,
                        height: height
                    };
                } catch (error) {
                    this.reserveTool.error = readableError(error, "Could not verify the reserve proof.");
                } finally {
                    this.reserveTool.loading = false;
                }
            },
            checkPaymentToolSubmit: async function () {
                this.paymentCheckTool.error = "";
                this.paymentCheckTool.result = null;
                if (!this.paymentCheckTool.txHash.trim() || !this.paymentCheckTool.secret.trim() || !this.paymentCheckTool.address.trim()) {
                    this.paymentCheckTool.error = "Transaction hash, secret/proof, and address are required.";
                    return;
                }
                this.paymentCheckTool.loading = true;
                try {
                    var txHash = this.paymentCheckTool.txHash.trim();
                    var resultMethod = "";
                    var params = {};
                    var secret = this.paymentCheckTool.secret.trim();
                    if (this.paymentCheckTool.keyType === "tx_key") {
                        resultMethod = "checktransactionkey";
                        params = {
                            transaction_id: txHash,
                            transaction_key: secret,
                            address: this.paymentCheckTool.address.trim()
                        };
                    } else if (this.paymentCheckTool.keyType === "view_key") {
                        if (secret.length === 256) secret = secret.slice(-64);
                        resultMethod = "checktransactionbyviewkey";
                        params = {
                            transaction_id: txHash,
                            view_key: secret,
                            address: this.paymentCheckTool.address.trim()
                        };
                    } else {
                        resultMethod = "checktransactionproof";
                        params = {
                            transaction_id: txHash,
                            signature: secret,
                            destination_address: this.paymentCheckTool.address.trim()
                        };
                    }
                    var responses = await Promise.all([
                        rpcCall(this.api, resultMethod, params),
                        rpcCall(this.api, "gettransaction", { hash: txHash }).catch(function () { return null; })
                    ]);
                    var verifyResult = responses[0];
                    var txResult = responses[1];
                    this.paymentCheckTool.txInfo = txResult && txResult.transaction ? txResult.transaction : null;
                    this.paymentCheckTool.result = this.paymentCheckTool.keyType === "tx_proof"
                        ? {
                            signatureValid: verifyResult.signature_valid !== false,
                            amount: verifyResult.received_amount || 0,
                            outputs: verifyResult.outputs || []
                        }
                        : {
                            signatureValid: true,
                            amount: verifyResult.amount || 0,
                            outputs: verifyResult.outputs || []
                        };
                } catch (error) {
                    this.paymentCheckTool.error = readableError(error, "Could not verify this payment.");
                } finally {
                    this.paymentCheckTool.loading = false;
                }
            },
            validateAddressToolSubmit: async function () {
                this.validateTool.error = "";
                this.validateTool.result = null;
                if (!this.validateTool.address.trim()) {
                    this.validateTool.error = "Enter an address to validate.";
                    return;
                }
                this.validateTool.loading = true;
                try {
                    var result = await rpcCall(this.api, "validateaddress", {
                        address: this.validateTool.address.trim()
                    });
                    this.validateTool.result = {
                        isValid: coerceBoolean(result.is_valid),
                        viewPublicKey: result.view_public_key || "",
                        spendPublicKey: result.spend_public_key || ""
                    };
                } catch (error) {
                    this.validateTool.error = readableError(error, "Could not validate that address.");
                } finally {
                    this.validateTool.loading = false;
                }
            },
            verifyMessageToolSubmit: async function () {
                this.verifyMessageTool.error = "";
                this.verifyMessageTool.result = null;
                if (!this.verifyMessageTool.address.trim() || !this.verifyMessageTool.signature.trim() || !this.verifyMessageTool.message.trim()) {
                    this.verifyMessageTool.error = "Fill address, signature, and message.";
                    return;
                }
                this.verifyMessageTool.loading = true;
                try {
                    var result = await rpcCall(this.api, "verifymessage", {
                        address: this.verifyMessageTool.address.trim(),
                        signature: this.verifyMessageTool.signature.trim(),
                        message: this.verifyMessageTool.message
                    });
                    this.verifyMessageTool.result = {
                        sigValid: coerceBoolean(result.sig_valid)
                    };
                } catch (error) {
                    this.verifyMessageTool.error = readableError(error, "Could not verify the message signature.");
                } finally {
                    this.verifyMessageTool.loading = false;
                }
            },
            convertAtomicToHuman: function () {
                var atomics = toAtomicBigInt(this.amountTool.atomic);
                if (atomics === null) {
                    this.showToast("Enter a valid atomic amount.", "error");
                    return;
                }
                this.amountTool.human = this.formatCoins(atomics, 12, false);
            },
            convertHumanToAtomic: function () {
                var atomics = toAtomicBigInt(this.amountTool.human);
                if (atomics === null) {
                    this.showToast("Enter a valid human-readable amount.", "error");
                    return;
                }
                this.amountTool.atomic = atomics.toString();
                this.amountTool.human = this.formatCoins(atomics, 12, false);
            },
            generatePaymentId: function () {
                this.paymentIdTool.paymentId = randomHex(64);
            },
            decodePaymentId: function () {
                this.paymentIdTool.memo = hexToAscii(this.paymentIdTool.paymentId);
            },
            encodePaymentIdMemo: function () {
                var memo = String(this.paymentIdTool.memo || "");
                if (memo.length > 32) {
                    this.showToast("Memo must be 32 ASCII characters or fewer.", "error");
                    return;
                }
                if (/[^\x00-\x7F]/.test(memo)) {
                    this.showToast("Memo must use ASCII only.", "error");
                    return;
                }
                this.paymentIdTool.paymentId = asciiToHex(memo.padStart(32, "0"));
            },
            generatePaperWallet: async function () {
                this.paperWallet.loading = true;
                this.paperWallet.error = "";
                try {
                    if (!window.cnUtil || !window.mn_encode || !window.poor_mans_kdf) {
                        await loadScriptOnce("/js/crypto_utils.js");
                    }
                    var seed = window.cnUtil.sc_reduce32(window.poor_mans_kdf(window.cnUtil.rand_32()));
                    var keys = window.cnUtil.create_address(seed);
                    this.paperWallet.wallet = {
                        address: keys.public_addr,
                        mnemonic: window.mn_encode(seed, "english"),
                        privateKeys: keys.privateKeys,
                        view: keys.view,
                        spend: keys.spend
                    };
                } catch (error) {
                    this.paperWallet.error = readableError(error, "Could not generate a paper wallet.");
                } finally {
                    this.paperWallet.loading = false;
                }
            },
            applySelectedNode: async function () {
                if (!this.settings.selectedNode) {
                    this.showToast("Choose a node first.", "error");
                    return;
                }
                await this.switchApi(this.settings.selectedNode);
            },
            applyCustomNode: async function () {
                var candidate = normalizeApiUrl(this.settings.customNode);
                if (!candidate || !isValidEndpoint(candidate)) {
                    this.showToast("Enter a valid node URL such as https://your-node:32448.", "error");
                    return;
                }
                this.settings.customNode = candidate;
                await this.switchApi(candidate);
            },
            switchApi: async function (candidate) {
                var previousApi = this.api;
                var previousSelected = this.settings.selectedNode;
                this.pageBusy = true;
                try {
                    var normalized = normalizeApiUrl(candidate);
                    var info = await fetchNodeInfo(normalized);
                    this.api = normalized;
                    this.settings.selectedNode = normalized;
                    this.stats = info;
                    this.statsStatus = "online";
                    this.lastStatsFetchedAt = Math.floor(Date.now() / 1000);
                    if ((window.apiList || []).map(normalizeApiUrl).indexOf(normalized) === -1) this.settings.customNode = normalized;
                    safeStorageSet(STORAGE_API_KEY, normalized);
                    await this.loadRouteData();
                    this.showToast("Switched RPC node.", "success");
                    return true;
                } catch (error) {
                    this.api = previousApi;
                    this.settings.selectedNode = previousSelected;
                    this.showToast(readableError(error, "Could not connect to that node."), "error");
                    return false;
                } finally {
                    this.pageBusy = false;
                }
            },
            verifyTransaction: async function () {
                if (!this.txView.tx) return;
                if (!this.txVerifier.secret || !this.txVerifier.address) {
                    this.txVerifier.error = "Enter the secret/proof and recipient address.";
                    this.txVerifier.result = null;
                    return;
                }
                this.txVerifier.loading = true;
                this.txVerifier.error = "";
                this.txVerifier.result = null;
                try {
                    var method = "";
                    var params = {};
                    var secret = this.txVerifier.secret.trim();
                    if (this.txVerifier.keyType === "tx_key") {
                        method = "checktransactionkey";
                        params = {
                            transaction_id: this.txView.tx.hash,
                            transaction_key: secret,
                            address: this.txVerifier.address.trim()
                        };
                    } else if (this.txVerifier.keyType === "view_key") {
                        if (secret.length === 256) secret = secret.slice(-64);
                        method = "checktransactionbyviewkey";
                        params = {
                            transaction_id: this.txView.tx.hash,
                            view_key: secret,
                            address: this.txVerifier.address.trim()
                        };
                    } else {
                        method = "checktransactionproof";
                        params = {
                            transaction_id: this.txView.tx.hash,
                            signature: secret,
                            destination_address: this.txVerifier.address.trim()
                        };
                    }
                    var result = await rpcCall(this.api, method, params);
                    if (this.txVerifier.keyType === "tx_proof") {
                        this.txVerifier.result = {
                            signatureValid: result.signature_valid !== false,
                            amount: result.received_amount || 0,
                            outputs: result.outputs || []
                        };
                    } else {
                        this.txVerifier.result = {
                            signatureValid: true,
                            amount: result.amount || 0,
                            outputs: result.outputs || []
                        };
                    }
                    this.activeTxTab = "outputs";
                } catch (error) {
                    this.txVerifier.error = readableError(error, "Transaction verification failed.");
                } finally {
                    this.txVerifier.loading = false;
                }
            },
            resetVerification: function () {
                this.txVerifier.keyType = "tx_key";
                this.txVerifier.secret = "";
                this.txVerifier.address = "";
                this.txVerifier.loading = false;
                this.txVerifier.error = "";
                this.txVerifier.result = null;
            },
            isOutputHighlighted: function (output, index) {
                if (this.route.query.highlight !== undefined && String(this.route.query.highlight) === String(index)) return true;
                if (!this.txVerifier.result || !Array.isArray(this.txVerifier.result.outputs)) return false;
                return this.txVerifier.result.outputs.some(function (candidate) {
                    return candidate && candidate.target && candidate.target.data && output && output.output && output.output.target && output.output.target.data
                        ? candidate.target.data.key === output.output.target.data.key
                        : false;
                });
            }
        },
        mounted: async function () {
            var _this3 = this;
            this.applyTheme();
            this.popstateHandler = function () { _this3.onPopState(); };
            window.addEventListener("popstate", this.popstateHandler);
            this.syncMobileHeaderViewport();
            this.mobileHeaderScrollHandler = function () { _this3.requestMobileHeaderUpdate(); };
            this.mobileHeaderResizeHandler = function () { _this3.syncMobileHeaderViewport(); };
            window.addEventListener("scroll", this.mobileHeaderScrollHandler, { passive: true });
            window.addEventListener("resize", this.mobileHeaderResizeHandler);
            this.clockTimerId = window.setInterval(function () {
                _this3.nowSeconds = Math.floor(Date.now() / 1000);
            }, 1000);
            this.pollTimerId = window.setInterval(async function () {
                try {
                    await _this3.loadStats({ allowFallback: false, silent: true });
                    if (_this3.route.name === "home") {
                        if (!_this3.home.hasNewer) _this3.home.pageHeight = _this3.getTipHeight();
                        await _this3.loadHomeData(++_this3.routeRequestId, true);
                    } else if (_this3.route.name === "nodes") {
                        await _this3.loadNodesData(++_this3.routeRequestId, true);
                    } else if (_this3.route.name === "alt-blocks") {
                        await _this3.loadAltBlocksData(++_this3.routeRequestId, true);
                    }
                } catch (error) {
                    return null;
                }
            }, REFRESH_DELAY);
            this.pageBusy = true;
            try {
                await this.loadStats({ allowFallback: true, silent: true });
                await this.loadRouteData();
            } finally {
                this.pageBusy = false;
            }
        },
        beforeUnmount: function () {
            this.destroyDifficultyChart();
            if (this.toastTimerId) window.clearTimeout(this.toastTimerId);
            if (this.clockTimerId) window.clearInterval(this.clockTimerId);
            if (this.pollTimerId) window.clearInterval(this.pollTimerId);
            if (this.popstateHandler) window.removeEventListener("popstate", this.popstateHandler);
            if (this.mobileHeaderScrollHandler) window.removeEventListener("scroll", this.mobileHeaderScrollHandler);
            if (this.mobileHeaderResizeHandler) window.removeEventListener("resize", this.mobileHeaderResizeHandler);
        }
    }).mount("#app");
})();
