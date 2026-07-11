(function () {
    "use strict";

    if (!window.Vue) return;

    var createApp = window.Vue.createApp;
    var STORAGE_THEME_KEY = "discrete_explorer_theme_v1";
    var STORAGE_API_KEY = "discrete_explorer_api_v1";
    var COIN_UNIT_STRING = String(window.coinUnits || "1000000000000");
    var COIN_UNIT_BIGINT = BigInt(COIN_UNIT_STRING);
    var COIN_DECIMALS = Math.max(COIN_UNIT_STRING.length - 1, 0);
    var REFRESH_DELAY = Number(window.refreshDelay) || 30000;
    var DEFAULT_PAGE_SIZE = Number(window.blocksPerPage) || 20;
    var RECENT_CONFIRMED_TX_LIMIT = 20;
    var RECENT_CONFIRMED_TX_SCAN_BATCH = Number(window.recentConfirmedTxBlockRange) || 1000;
    var HISTORIC_STATS_TARGET_STEP = Math.max(Number(window.historicStatsSampleStep) || 1000, 1);
    var HISTORIC_STATS_MAX_POINTS = Math.max(Number(window.historicStatsMaxPoints) || 1500, 2);
    var HISTORIC_STATS_RANGE_LIMIT = Math.max(Math.min(Number(window.historicStatsRangeLimit) || 10000, 10000), 2);
    var DATE_LOCALE = "en-GB";
    var AVG_HASHRATE_BASELINE_HEIGHT = coerceInteger(window.avgHashrateBaselineHeight);
    var AVG_HASHRATE_BASELINE_CUMULATIVE_DIFFICULTY = toBigIntValue(window.avgHashrateBaselineCumulativeDifficulty);
    var HISTORIC_STATS_METRICS = [
        { key: "difficulty", label: "Difficulty", icon: "fa-wave-square" },
        { key: "hashrate", label: "Hashrate", icon: "fa-tachometer-alt" },
        { key: "block_size", label: "Block size", icon: "fa-cube" },
        { key: "transactions_count", label: "Txs / block", icon: "fa-receipt" },
        { key: "reward", label: "Reward", icon: "fa-coins" },
        { key: "already_generated_coins", label: "Supply", icon: "fa-chart-area" }
    ];
    var ADDRESS_PATTERN = window.addressPattern instanceof RegExp
        ? window.addressPattern
        : /^(disc|tdisc)1[02-9ac-hj-np-z]{1000,}$/;
    var ACCOUNT_NUMBER_PATTERN = window.accountNumberPattern instanceof RegExp
        ? window.accountNumberPattern
        : /^\d+-\d+-[0-9A-Za-z]$/;
    var ACCOUNT_NUMBER_WITH_INDEX_PATTERN = window.accountNumberWithIndexPattern instanceof RegExp
        ? window.accountNumberWithIndexPattern
        : /^\d+-\d+-\d+-[0-9A-Za-z]$/;
    // Discrete PQ constants (must match CryptoNoteConfig / TransactionExtra):
    var PQ_VIEW_PUBKEY_BYTES = 1184;   // ML-KEM-768 public key
    var PQ_SPEND_PUBKEY_BYTES = 1952;  // ML-DSA-65 public key
    var PQ_SIGNATURE_BYTES = 3309;     // ML-DSA-65 signature
    var TX_TYPE_COINBASE = 0;
    var TX_TYPE_TRANSFER = 1;
    var TX_TYPE_FREE_REG = 3;
    var SIMPLE_ROUTE_NAMES = [
        "nodes",
        "charts",
        "alt-blocks",
        "tools",
        "broadcast-transaction",
        "validate-address",
        "verify-message",
        "amount-converter",
        "payment-id-tools",
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

    function isLocalDevOrigin() {
        return typeof window !== "undefined"
            && window.location
            && /^(localhost|127\.0\.0\.1)$/i.test(window.location.hostname || "");
    }

    function isLoopbackApi(url) {
        try {
            var parsed = new URL(normalizeApiUrl(url));
            return /^(localhost|127\.0\.0\.1)$/i.test(parsed.hostname || "");
        } catch (error) {
            return false;
        }
    }

    function buildApiRequestUrl(apiUrl, pathname) {
        var normalizedApi = normalizeApiUrl(apiUrl);
        var normalizedPath = String(pathname || "");
        if (isLocalDevOrigin() && isLoopbackApi(normalizedApi)) {
            return "/__proxy__?target=".concat(encodeURIComponent(normalizedApi + normalizedPath));
        }
        return "".concat(normalizedApi).concat(normalizedPath);
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

    function normalizeAccountNumber(value) {
        var raw = String(value || "").trim();
        if (!raw) return "";
        var parts = raw.split("-");
        if (parts.length !== 3 && parts.length !== 4) return raw;
        var check = String(parts[parts.length - 1] || "").toUpperCase();
        return parts.slice(0, parts.length - 1).join("-") + "-" + check;
    }

    // Parses both account-number forms: H-I-C (base account) and H-I-T-C
    // (deposit subaddress, T = routing index). C is Luhn mod-36 over the
    // concatenated decimal digits of the preceding fields.
    function parseAccountNumber(value) {
        var normalized = normalizeAccountNumber(value);
        var withIndex = ACCOUNT_NUMBER_WITH_INDEX_PATTERN.test(normalized);
        if (!withIndex && !ACCOUNT_NUMBER_PATTERN.test(normalized)) return null;
        var parts = normalized.split("-");
        var blockHeight = coerceInteger(parts[0]);
        var txIndex = coerceInteger(parts[1]);
        var subaddressIndex = withIndex ? coerceInteger(parts[2]) : null;
        if (blockHeight === null || blockHeight < 0 || txIndex === null || txIndex < 0) return null;
        if (withIndex && (subaddressIndex === null || subaddressIndex < 0)) return null;
        return {
            value: normalized,
            blockHeight: blockHeight,
            txIndex: txIndex,
            subaddressIndex: subaddressIndex,
            checkDigit: parts[parts.length - 1],
            luhnPayload: withIndex
                ? String(parts[0]) + String(parts[1]) + String(parts[2])
                : String(parts[0]) + String(parts[1])
        };
    }

    function isValidAccountNumber(value) {
        var parsed = parseAccountNumber(value);
        if (!parsed) return false;
        return luhnMod36Generate(parsed.luhnPayload) === parsed.checkDigit;
    }

    function isAccountNumberCandidate(value) {
        var normalized = normalizeAccountNumber(value);
        return ACCOUNT_NUMBER_PATTERN.test(normalized) || ACCOUNT_NUMBER_WITH_INDEX_PATTERN.test(normalized);
    }

    // --- bech32m (BIP-350) decoding for Discrete PQ addresses -------------
    // Address layout after 5->8 bit regrouping:
    //   version (1) || varint(networkPrefix) || viewPub (1184) || spendPub (1952) || checksum (4)
    // The trailing 4-byte checksum is consensus data (SHA3-256 prefix) verified
    // by wallets/nodes; here the bech32m checksum already guarantees integrity.
    var BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
    var BECH32M_CONST = 0x2bc830a3;

    function bech32Polymod(values) {
        var generator = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
        var checksum = 1;
        for (var index = 0; index < values.length; index += 1) {
            var top = checksum >>> 25;
            checksum = ((checksum & 0x1ffffff) << 5) ^ values[index];
            for (var bit = 0; bit < 5; bit += 1) {
                if ((top >>> bit) & 1) checksum ^= generator[bit];
            }
        }
        return checksum >>> 0;
    }

    function bech32HrpExpand(hrp) {
        var expanded = [];
        var index;
        for (index = 0; index < hrp.length; index += 1) expanded.push(hrp.charCodeAt(index) >>> 5);
        expanded.push(0);
        for (index = 0; index < hrp.length; index += 1) expanded.push(hrp.charCodeAt(index) & 31);
        return expanded;
    }

    function convertBits(data, fromBits, toBits, pad) {
        var accumulator = 0;
        var bits = 0;
        var result = [];
        var maxValue = (1 << toBits) - 1;
        for (var index = 0; index < data.length; index += 1) {
            var value = data[index];
            if (value < 0 || value >>> fromBits !== 0) return null;
            accumulator = (accumulator << fromBits) | value;
            bits += fromBits;
            while (bits >= toBits) {
                bits -= toBits;
                result.push((accumulator >>> bits) & maxValue);
            }
        }
        if (pad) {
            if (bits > 0) result.push((accumulator << (toBits - bits)) & maxValue);
        } else if (bits >= fromBits || ((accumulator << (toBits - bits)) & maxValue)) {
            return null;
        }
        return result;
    }

    // Decodes and validates a Discrete PQ address. Returns null when the string
    // is not a well-formed bech32m address with the expected key lengths.
    function decodePqAddress(value) {
        var raw = String(value || "").trim();
        if (!raw) return null;
        var hasLower = raw !== raw.toUpperCase();
        var hasUpper = raw !== raw.toLowerCase();
        if (hasLower && hasUpper) return null;
        raw = raw.toLowerCase();
        var separator = raw.lastIndexOf("1");
        if (separator < 1 || separator + 7 > raw.length) return null;
        var hrp = raw.slice(0, separator);
        if (hrp !== "disc" && hrp !== "tdisc") return null;
        var data = [];
        for (var index = separator + 1; index < raw.length; index += 1) {
            var charValue = BECH32_CHARSET.indexOf(raw.charAt(index));
            if (charValue === -1) return null;
            data.push(charValue);
        }
        if (bech32Polymod(bech32HrpExpand(hrp).concat(data)) !== BECH32M_CONST) return null;
        var bytes = convertBits(data.slice(0, data.length - 6), 5, 8, false);
        if (!bytes || bytes.length < 2 + PQ_VIEW_PUBKEY_BYTES + PQ_SPEND_PUBKEY_BYTES + 4) return null;
        var offset = 0;
        var version = bytes[offset];
        offset += 1;
        var networkPrefix = 0;
        var shift = 0;
        while (offset < bytes.length) {
            var byteValue = bytes[offset];
            offset += 1;
            networkPrefix += (byteValue & 0x7f) * Math.pow(2, shift);
            shift += 7;
            if ((byteValue & 0x80) === 0) break;
            if (shift > 63) return null;
        }
        if (bytes.length - offset !== PQ_VIEW_PUBKEY_BYTES + PQ_SPEND_PUBKEY_BYTES + 4) return null;
        var viewPub = bytes.slice(offset, offset + PQ_VIEW_PUBKEY_BYTES);
        offset += PQ_VIEW_PUBKEY_BYTES;
        var spendPub = bytes.slice(offset, offset + PQ_SPEND_PUBKEY_BYTES);
        return {
            hrp: hrp,
            isTestnet: hrp === "tdisc",
            network: hrp === "tdisc" ? "testnet" : "mainnet",
            version: version,
            networkPrefix: networkPrefix,
            viewPublicKey: bytesToHex(viewPub),
            spendPublicKey: bytesToHex(spendPub)
        };
    }

    function isPqAddressCandidate(value) {
        var raw = String(value || "").trim().toLowerCase();
        return ADDRESS_PATTERN.test(raw);
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
        if (withSymbol) rendered += " " + String(window.symbol || "XDS");
        return rendered;
    }

    function correctOverflow(value) {
        var num = Number(value);
        if (!Number.isFinite(num)) return String(value);
        const MAX_UINT64 = BigInt("18446744073709551616"); // 2^64
        num = BigInt(value);
        if (num < 0) {
            num += MAX_UINT64;  // Correct the negative overflow
        }
        return String(num); // Return as string to avoid BigInt issues in JSON
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
        decoded = decoded.replace(/^\u0000+/g, "").replace(/\u0000+$/g, "").trim();
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

    // Walks Discrete tx_extra (hex). Fixed layouts per tag:
    //   0x00 padding (zero byte), 0x01 legacy pubkey (32 B),
    //   0x02 nonce (1 size byte + data; payment id when it starts with 0x00),
    //   0x04 legacy ECC registration (64 B, never on-chain in Discrete),
    //   0x05 PQ account registration (viewPub 1184 B + spendPub 1952 B),
    //   0x06 anti-spam PoW (ref block hash 32 B + nonce 8 B),
    //   0x07 coinbase miner spend pubkey (1952 B).
    function parsePqExtra(rawExtra) {
        var result = { registration: null, minerSpendPublicKey: "" };
        var raw = normalizeHex(rawExtra);
        var cursor = 0;

        while (cursor + 2 <= raw.length) {
            var tag = raw.slice(cursor, cursor + 2);
            cursor += 2;

            if (tag === "00") continue;

            if (tag === "01") {
                cursor += 64;
                continue;
            }

            if (tag === "02") {
                if (cursor + 2 > raw.length) break;
                var nonceLength = parseInt(raw.slice(cursor, cursor + 2), 16);
                if (!Number.isFinite(nonceLength) || nonceLength < 0) break;
                cursor += 2 + nonceLength * 2;
                continue;
            }

            if (tag === "04") {
                cursor += 128;
                continue;
            }

            if (tag === "05") {
                var registrationHexLength = (PQ_VIEW_PUBKEY_BYTES + PQ_SPEND_PUBKEY_BYTES) * 2;
                if (cursor + registrationHexLength > raw.length) break;
                result.registration = {
                    viewPublicKey: raw.slice(cursor, cursor + PQ_VIEW_PUBKEY_BYTES * 2),
                    spendPublicKey: raw.slice(cursor + PQ_VIEW_PUBKEY_BYTES * 2, cursor + registrationHexLength)
                };
                cursor += registrationHexLength;
                continue;
            }

            if (tag === "06") {
                cursor += 80;
                continue;
            }

            if (tag === "07") {
                if (cursor + PQ_SPEND_PUBKEY_BYTES * 2 > raw.length) break;
                result.minerSpendPublicKey = raw.slice(cursor, cursor + PQ_SPEND_PUBKEY_BYTES * 2);
                cursor += PQ_SPEND_PUBKEY_BYTES * 2;
                continue;
            }

            break;
        }

        return result;
    }

    function luhnMod36Generate(input) {
        var alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
        var sum = 0;
        var shouldDouble = true;

        for (var index = String(input || "").length - 1; index >= 0; index -= 1) {
            var character = String(input).charAt(index).toUpperCase();
            var value = alphabet.indexOf(character);
            if (value < 0) return "";

            if (shouldDouble) {
                value *= 2;
                if (value >= 36) value = Math.floor(value / 36) + (value % 36);
            }

            sum += value;
            shouldDouble = !shouldDouble;
        }

        var remainder = sum % 36;
        return alphabet.charAt((36 - remainder) % 36);
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

    function stringifyJsonIntegerFields(jsonText, fieldNames) {
        var result = String(jsonText || "");
        (fieldNames || []).forEach(function (fieldName) {
            var escapedName = String(fieldName).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            var pattern = new RegExp('("' + escapedName + '"\\s*:\\s*)(-?\\d+)', "g");
            result = result.replace(pattern, '$1"$2"');
        });
        return result;
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

    function atomicToCoinNumber(value) {
        var atomics = toAtomicBigInt(value);
        if (atomics === null) return 0;
        return Number(atomics) / Number(COIN_UNIT_BIGINT || 1n);
    }

    function buildHistoricSampleHeights(tipHeight) {
        var tip = coerceInteger(tipHeight);
        if (tip === null || tip < 0) return [];

        var step = Math.max(HISTORIC_STATS_TARGET_STEP, Math.ceil(Math.max(tip, 1) / (HISTORIC_STATS_MAX_POINTS - 1)));
        var heights = [];
        for (var height = 0; height < tip; height += step) {
            heights.push(height);
        }
        if (!heights.length || heights[heights.length - 1] !== tip) heights.push(tip);

        return heights.filter(function (heightValue, index) {
            return index === 0 || heightValue !== heights[index - 1];
        });
    }

    function buildHistoricRangeSampleHeights(startHeight, endHeight) {
        var start = Math.max(coerceInteger(startHeight) || 0, 0);
        var end = Math.max(coerceInteger(endHeight) || 0, 0);
        if (start > end) {
            var originalStart = start;
            start = end;
            end = originalStart;
        }

        var span = Math.max(end - start, 1);
        var step = Math.max(1, Math.ceil(span / (HISTORIC_STATS_MAX_POINTS - 1)));
        var heights = [];
        for (var height = start; height < end; height += step) {
            heights.push(height);
        }
        if (!heights.length || heights[heights.length - 1] !== end) heights.push(end);

        return heights.filter(function (heightValue, index) {
            return index === 0 || heightValue !== heights[index - 1];
        });
    }

    function thinHistoricStats(stats) {
        var list = (stats || []).slice();
        if (list.length <= HISTORIC_STATS_MAX_POINTS) return list;

        var step = Math.ceil((list.length - 1) / (HISTORIC_STATS_MAX_POINTS - 1));
        var thinned = [];
        for (var index = 0; index < list.length; index += step) {
            thinned.push(list[index]);
        }
        if (thinned[thinned.length - 1] !== list[list.length - 1]) thinned.push(list[list.length - 1]);
        return thinned;
    }

    function normalizeHistoricStats(stats) {
        var seen = Object.create(null);
        return (stats || []).map(function (stat) {
            var height = coerceInteger(stat && stat.height);
            if (height === null || height < 0) return null;
            return {
                height: height,
                timestamp: coerceInteger(stat.timestamp) || 0,
                difficulty: Number(stat.difficulty || 0),
                transactionsCount: coerceInteger(stat.transactions_count) || 0,
                blockSize: coerceInteger(stat.block_size) || 0,
                reward: stat.reward || 0,
                alreadyGeneratedCoins: correctOverflow(stat.already_generated_coins || 0)
            };
        }).filter(Boolean).sort(function (left, right) {
            return left.height - right.height;
        }).filter(function (point) {
            if (seen[point.height]) return false;
            seen[point.height] = true;
            return true;
        });
    }

    function getHistoricStatsMetric(key) {
        var normalizedKey = String(key || "");
        for (var index = 0; index < HISTORIC_STATS_METRICS.length; index += 1) {
            if (HISTORIC_STATS_METRICS[index].key === normalizedKey) return HISTORIC_STATS_METRICS[index];
        }
        return HISTORIC_STATS_METRICS[0];
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
        if (name === "account-number" && params.accountNumber) {
            normalized.name = "account-number";
            normalized.params.accountNumber = normalizeAccountNumber(params.accountNumber);
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
        if (normalized.name === "account-number") return "/account/".concat(encodeURIComponent(normalized.params.accountNumber));
        var path = "/".concat(normalized.name, "/").concat(encodeURIComponent(normalized.params.hash));
        if (normalized.name === "transaction" && normalized.query.highlight) query.set("highlight", normalized.query.highlight);
        var search = query.toString();
        return search ? "".concat(path, "?").concat(search) : path;
    }

    function parseLegacyRoute(locationObject) {
        var params = new URLSearchParams(locationObject.search || "");
        var hash = String(locationObject.hash || "").replace(/^#/, "").toLowerCase();
        var value = params.get("hash");
        var address = params.get("address");
        if (value) {
            if (hash === "block") return normalizeRoute({ name: "block", params: { hash: value } });
            if (hash === "transaction") return normalizeRoute({ name: "transaction", params: { hash: value } });
            if (hash === "payment-id" || hash === "payment_id") return normalizeRoute({ name: "payment-id", params: { hash: value } });
        }
        if (address && hash === "address") {
            return normalizeRoute({ name: "address", params: { address: address } });
        }
        if (hash === "nodes") return normalizeRoute({ name: "nodes" });
        if (hash === "alt-blocks" || hash === "alt_blocks") return normalizeRoute({ name: "alt-blocks" });
        if (hash === "tools") return normalizeRoute({ name: "tools" });
        if (hash === "pushtx") return normalizeRoute({ name: "broadcast-transaction" });
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
        if ((segments[0] === "account" || segments[0] === "account-number") && segments[1]) return normalizeRoute({ name: "account-number", params: { accountNumber: segments[1] } });
        return normalizeRoute({ name: "home", query: query });
    }

    async function fetchJson(url, init) {
        var options = Object.assign({ cache: "no-store", headers: {} }, init || {});
        options.headers = Object.assign({}, init && init.headers ? init.headers : {});
        var timeoutMs = Number(options.timeoutMs);
        var bigIntFields = Array.isArray(options.bigIntFields) ? options.bigIntFields : [];
        delete options.timeoutMs;
        delete options.bigIntFields;

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
            try {
                var responseText = await response.text();
                payload = JSON.parse(bigIntFields.length ? stringifyJsonIntegerFields(responseText, bigIntFields) : responseText);
            } catch (error) {
                throw new Error("Invalid JSON response.");
            }
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
        return fetchJson(buildApiRequestUrl(apiUrl, "/getinfo"), {
            headers: { Accept: "application/json" },
            timeoutMs: 5000
        });
    }

    async function sendRawTransaction(apiUrl, transactionHex) {
        return fetchJson(buildApiRequestUrl(apiUrl, "/sendrawtransaction"), {
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

    async function rpcCall(apiUrl, method, params, options) {
        var requestOptions = Object.assign({
            method: "POST",
            headers: { Accept: "application/json", "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: "discrete_explorer", method: method, params: params || {} })
        }, options || {});
        var payload = await fetchJson(buildApiRequestUrl(apiUrl, "/json_rpc"), requestOptions);
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
                addressExpanded: false,
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
                    { name: "charts", label: "Charts", icon: "fa-chart-area" },
                    { name: "nodes", label: "Nodes", icon: "fa-server" },
                    { name: "alt-blocks", label: "Alt blocks", icon: "fa-code-branch" },
                    { name: "tools", label: "Tools", icon: "fa-th-large" },
                    { name: "settings", label: "Settings", icon: "fa-sliders-h" }
                ],
                toolNav: [
                    { name: "broadcast-transaction", label: "Broadcast tx", icon: "fa-broadcast-tower", description: "Submit raw transaction hex to the network." },
                    { name: "validate-address", label: "Validate address", icon: "fa-check-circle", description: "Validate an address or account number." },
                    { name: "verify-message", label: "Verify message", icon: "fa-envelope-open-text", description: "Verify a post-quantum signed message." },
                    { name: "amount-converter", label: "Amount converter", icon: "fa-exchange-alt", description: "Convert atomic units to readable XDS amounts." },
                    { name: "payment-id-tools", label: "Payment ID tools", icon: "fa-fingerprint", description: "Generate, encode, and decode payment IDs." }
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
                addressView: { loading: false, error: "", result: null, accountNumber: null, accountNumberError: "" },
                accountNumberView: { loading: false, error: "", result: null },
                historicStats: {
                    loading: false,
                    error: "",
                    points: [],
                    navigatorPoints: [],
                    metric: "difficulty",
                    viewMode: "all",
                    customStart: "",
                    customEnd: "",
                    source: "",
                    sampleStep: 0,
                    requestedPoints: 0,
                    requestDuration: null,
                    loadedAt: 0
                },
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
                charts: {
                    difficulty: null,
                    historicStats: null,
                    historicStatsNavigator: null
                },
                activeTxTab: "outputs"
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
                var txType = coerceInteger(this.txView.tx.txType);
                if (txType === TX_TYPE_COINBASE) return "Coinbase";
                if (txType === TX_TYPE_FREE_REG) return "Free";
                return this.formatCoins(this.txView.tx.fee);
            },
            transactionRawExtra: function () {
                if (!this.txView.tx || !this.txView.tx.extra) return "";
                return normalizeHex(this.txView.tx.extra.raw || "");
            },
            transactionMinerSpendPub: function () {
                if (!this.txView.tx) return "";
                if (coerceInteger(this.txView.tx.txType) !== TX_TYPE_COINBASE) return "";
                return parsePqExtra(this.transactionRawExtra).minerSpendPublicKey;
            },
            transactionSignatureSummary: function () {
                if (!this.txView.tx) return "";
                if (coerceInteger(this.txView.tx.txType) !== TX_TYPE_TRANSFER) return "";
                var inputCount = (this.txView.tx.inputs || []).length;
                if (!inputCount) return "";
                return "This transfer carries " + this.formatNumber(inputCount)
                    + " ML-DSA-65 signature" + (inputCount === 1 ? "" : "s")
                    + " (one per input, " + this.formatNumber(PQ_SIGNATURE_BYTES)
                    + " bytes each), verified by every node. Signatures are not included in the RPC detail payload.";
            },
            blockMinerSignatureHex: function () {
                if (!this.blockView.block) return "";
                var signature = this.blockView.block.minerSignature;
                if (Array.isArray(signature)) return bytesToHex(signature);
                var normalized = normalizeHex(signature);
                return /^0*$/.test(normalized) ? "" : normalized;
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
                    var chartTimestamp = timestamp > 0 ? timestamp : 1781619660;
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
            historicStatsMetrics: function () {
                return HISTORIC_STATS_METRICS;
            },
            historicStatsChart: function () {
                var metric = getHistoricStatsMetric(this.historicStats.metric);
                var points = (this.historicStats.points || []).map(function (point) {
                    var value = this.getHistoricStatsMetricValue(point, metric.key);
                    if (!Number.isFinite(value)) return null;
                    return Object.assign({}, point, {
                        value: value,
                        chartTime: point.timestamp > 0 ? new Date(point.timestamp * 1000).toISOString() : "",
                        dateTime: point.timestamp > 0 ? this.formatDateTime(point.timestamp) : "Unknown time",
                        displayValue: this.formatHistoricStatsMetricValue(metric.key, point, value, false)
                    });
                }, this).filter(Boolean);

                if (!points.length) return null;

                var values = points.map(function (point) { return point.value; });
                var sampleStep = this.historicStats.sampleStep || (points.length > 1 ? points[1].height - points[0].height : 0);
                var firstPoint = points[0];
                var lastPoint = points[points.length - 1];
                var maximumPoint = points.reduce(function (bestPoint, point) {
                    return point.value > bestPoint.value ? point : bestPoint;
                }, firstPoint);

                return {
                    metric: metric,
                    points: points,
                    labels: points.map(function (point) { return point.height; }),
                    latest: lastPoint,
                    average: average(values),
                    maximum: maximumPoint.value,
                    maximumPoint: maximumPoint,
                    firstHeight: firstPoint.height,
                    lastHeight: lastPoint.height,
                    sampleStep: sampleStep,
                    source: this.historicStats.source,
                    sourceLabel: this.historicStats.source === "range"
                        ? "Zoom range"
                        : this.historicStats.source === "sparse-zoom"
                            ? "Sampled zoom"
                        : this.historicStats.source === "range-fallback"
                            ? "Recent range"
                            : "Full history",
                    rangeLabel: "H ".concat(this.formatNumber(firstPoint.height), " - H ").concat(this.formatNumber(lastPoint.height))
                };
            },
            historicStatsNavigatorChart: function () {
                var metric = getHistoricStatsMetric(this.historicStats.metric);
                var sourcePoints = this.historicStats.navigatorPoints && this.historicStats.navigatorPoints.length
                    ? this.historicStats.navigatorPoints
                    : this.historicStats.points;
                var points = (sourcePoints || []).map(function (point) {
                    var value = this.getHistoricStatsMetricValue(point, metric.key);
                    if (!Number.isFinite(value)) return null;
                    return Object.assign({}, point, {
                        value: value
                    });
                }, this).filter(Boolean);

                if (!points.length) return null;

                return {
                    metric: metric,
                    points: points,
                    labels: points.map(function (point) { return point.height; })
                };
            },
            historicStatsHandleRange: function () {
                var tipHeight = this.getTipHeight();
                var max = tipHeight === null ? 0 : Math.max(tipHeight, 0);
                var chart = this.historicStatsChart;
                var start = coerceInteger(this.historicStats.customStart);
                var end = coerceInteger(this.historicStats.customEnd);

                if (this.historicStats.viewMode !== "custom" || start === null || end === null) {
                    start = chart ? chart.firstHeight : 0;
                    end = chart ? chart.lastHeight : max;
                }

                start = Math.min(Math.max(start || 0, 0), max);
                end = Math.min(Math.max(end || 0, 0), max);
                if (start > end) {
                    var originalStart = start;
                    start = end;
                    end = originalStart;
                }

                var divisor = max > 0 ? max : 1;
                return {
                    min: 0,
                    max: max,
                    start: start,
                    end: end,
                    leftPercent: start / divisor * 100,
                    rightPercent: Math.max(0, 100 - (end / divisor * 100)),
                    span: end - start + 1
                };
            },
            historicStatsCustomRangeReady: function () {
                if (String(this.historicStats.customStart).trim() === "" || String(this.historicStats.customEnd).trim() === "") {
                    return false;
                }

                var start = coerceInteger(this.historicStats.customStart);
                var end = coerceInteger(this.historicStats.customEnd);
                return start !== null && end !== null && start >= 0 && end >= 0;
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
            txTypeName: function (txType) {
                var normalized = coerceInteger(txType);
                if (normalized === TX_TYPE_COINBASE) return "Coinbase";
                if (normalized === TX_TYPE_TRANSFER) return "Transfer";
                if (normalized === TX_TYPE_FREE_REG) return "Account registration";
                return "Unknown (" + String(txType) + ")";
            },
            transactionFeeCell: function (transaction) {
                if (!transaction) return "--";
                var txType = coerceInteger(transaction.txType);
                if (txType === TX_TYPE_COINBASE || txType === TX_TYPE_FREE_REG) return "\u2014";
                return this.formatCoins(transaction.fee, false);
            },
            coerceNumber: function (value) {
                return coerceInteger(value) || 0;
            },
            shortHash: function (hash) {
                var normalized = String(hash || "").trim();
                if (normalized.length <= 16) return normalized;
                return normalized.slice(0, 8) + "\u2026" + normalized.slice(-8);
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
            correctOverflow: function (value) {
                return correctOverflow(value);
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
            formatCoinUnits: function (value) {
                var numeric = Number(value);
                if (!Number.isFinite(numeric)) return "--";
                var rendered = numeric.toLocaleString(undefined, {
                    maximumFractionDigits: numeric >= 1000 ? 0 : numeric >= 10 ? 2 : 4
                });
                return "".concat(rendered, " ").concat(String(window.symbol || "XDS"));
            },
            getHistoricStatsMetricValue: function (point, metricKey) {
                if (!point) return NaN;
                if (metricKey === "difficulty") return Number(point.difficulty || 0);
                if (metricKey === "hashrate") return this.blockTargetInterval > 0 ? Number(point.difficulty || 0) / this.blockTargetInterval : 0;
                if (metricKey === "block_size") return Number(point.blockSize || 0);
                if (metricKey === "transactions_count") return Number(point.transactionsCount || 0);
                if (metricKey === "reward") return atomicToCoinNumber(point.reward);
                if (metricKey === "already_generated_coins") return atomicToCoinNumber(point.alreadyGeneratedCoins);
                return NaN;
            },
            formatHistoricStatsMetricValue: function (metricKey, point, value, axisValue) {
                if (metricKey === "difficulty") return this.formatDifficulty(Math.round(value));
                if (metricKey === "hashrate") return this.formatHashrate(value);
                if (metricKey === "block_size") return this.formatBytes(value);
                if (metricKey === "transactions_count") return this.formatNumber(Math.round(value * 10) / 10);
                if (metricKey === "reward") return axisValue ? this.formatCoinUnits(value) : this.formatCoins(point && point.reward, 6);
                if (metricKey === "already_generated_coins") return axisValue ? this.formatCoinUnits(value) : this.formatCoins(point && point.alreadyGeneratedCoins);
                return this.formatNumber(value);
            },
            setHistoricStatsMetric: function (metricKey) {
                var metric = getHistoricStatsMetric(metricKey);
                if (this.historicStats.metric === metric.key) return;
                this.historicStats.metric = metric.key;
                this.scheduleHistoricStatsChartRender();
            },
            getHistoricStatsRange: function (tipHeight) {
                var tip = coerceInteger(tipHeight);
                if (tip === null || tip < 0 || this.historicStats.viewMode === "all") return null;

                var start = 0;
                var end = tip;
                if (this.historicStats.viewMode === "last-1000") {
                    start = Math.max(tip - 999, 0);
                } else if (this.historicStats.viewMode === "last-10000") {
                    start = Math.max(tip - HISTORIC_STATS_RANGE_LIMIT + 1, 0);
                } else if (this.historicStats.viewMode === "custom") {
                    start = coerceInteger(this.historicStats.customStart);
                    end = coerceInteger(this.historicStats.customEnd);
                    if (start === null || end === null || start < 0 || end < 0) {
                        throw new Error("Enter valid start and end heights.");
                    }
                    start = Math.min(start, tip);
                    end = Math.min(end, tip);
                    if (start > end) {
                        var originalStart = start;
                        start = end;
                        end = originalStart;
                    }
                }

                var requestedBlocks = end - start + 1;
                return {
                    start: start,
                    end: end,
                    count: requestedBlocks
                };
            },
            setHistoricStatsHandle: function (side, value) {
                var range = this.historicStatsHandleRange;
                var nextValue = coerceInteger(value);
                if (nextValue === null) return;

                nextValue = Math.min(Math.max(nextValue, range.min), range.max);
                var start = range.start;
                var end = range.end;
                if (side === "start") {
                    start = Math.min(nextValue, end);
                } else {
                    end = Math.max(nextValue, start);
                }

                this.historicStats.viewMode = "custom";
                this.historicStats.customStart = String(start);
                this.historicStats.customEnd = String(end);
            },
            setHistoricStatsView: async function (viewMode) {
                var nextMode = viewMode === "last-1000" || viewMode === "last-10000" ? viewMode : "all";
                this.historicStats.viewMode = nextMode;
                this.historicStats.error = "";
                await this.loadHistoricStatsData(++this.routeRequestId, false);
            },
            applyHistoricStatsCustomRange: async function () {
                if (!this.historicStatsCustomRangeReady) return;
                this.historicStats.viewMode = "custom";
                this.historicStats.error = "";
                await this.loadHistoricStatsData(++this.routeRequestId, false);
            },
            resetHistoricStatsZoom: async function () {
                this.historicStats.viewMode = "all";
                this.historicStats.customStart = "";
                this.historicStats.customEnd = "";
                this.historicStats.error = "";
                await this.loadHistoricStatsData(++this.routeRequestId, false);
            },
            zoomHistoricStatsAroundHeight: async function (height) {
                var center = coerceInteger(height);
                var tipHeight = this.getTipHeight();
                if (center === null || tipHeight === null) return;

                var model = this.historicStatsChart;
                var currentSpan = model ? model.lastHeight - model.firstHeight + 1 : HISTORIC_STATS_RANGE_LIMIT;
                var nextSpan = model && this.historicStats.source === "range"
                    ? Math.max(Math.floor(currentSpan / 4), 200)
                    : HISTORIC_STATS_RANGE_LIMIT;
                nextSpan = Math.min(Math.max(nextSpan, 1), HISTORIC_STATS_RANGE_LIMIT);

                var start = Math.max(center - Math.floor(nextSpan / 2), 0);
                var end = Math.min(start + nextSpan - 1, tipHeight);
                start = Math.max(end - nextSpan + 1, 0);

                this.historicStats.viewMode = "custom";
                this.historicStats.customStart = String(start);
                this.historicStats.customEnd = String(end);
                this.historicStats.error = "";
                await this.loadHistoricStatsData(++this.routeRequestId, false);
            },
            computeAccountNumber: function (blockHeight, txIndex) {
                var normalizedHeight = coerceInteger(blockHeight);
                var normalizedTxIndex = coerceInteger(txIndex);
                if (normalizedHeight === null || normalizedHeight < 0 || normalizedTxIndex === null || normalizedTxIndex < 0) return "";
                var payload = String(normalizedHeight) + String(normalizedTxIndex);
                var checkDigit = luhnMod36Generate(payload);
                if (!checkDigit) return "";
                return "".concat(normalizedHeight, "-").concat(normalizedTxIndex, "-").concat(checkDigit);
            },
            extractBlockTransactionIndex: function (block, transactionHash) {
                var normalizedHash = String(transactionHash || "").trim().toLowerCase();
                if (!block || !Array.isArray(block.transactions) || !normalizedHash) return null;
                for (var index = 0; index < block.transactions.length; index += 1) {
                    var item = block.transactions[index];
                    var itemHash = typeof item === "string"
                        ? item
                        : item && (item.hash || item.transactionHash || item.tx_hash || item.id);
                    if (String(itemHash || "").trim().toLowerCase() === normalizedHash) return index;
                }
                return null;
            },
            enrichTransactionAccountRegistration: async function (transaction, token) {
                if (!transaction || !transaction.accountRegistration || !transaction.inBlockchain || !transaction.blockHash) return transaction;

                var registration = Object.assign({}, transaction.accountRegistration, {
                    blockHeight: coerceInteger(transaction.blockIndex),
                    confirmed: true
                });
                transaction.accountRegistration = registration;

                try {
                    var blockResult = await rpcCall(this.api, "getblockbyhash", { hash: transaction.blockHash });
                    if (token !== this.routeRequestId) return null;
                    var block = blockResult && blockResult.block ? blockResult.block : blockResult;
                    var txIndex = this.extractBlockTransactionIndex(block, transaction.hash);
                    if (txIndex === null) return transaction;

                    registration.txIndex = txIndex;
                    registration.accountNumber = this.computeAccountNumber(registration.blockHeight, txIndex);
                    if (!registration.accountNumber) return transaction;

                    try {
                        var resolved = await rpcCall(this.api, "resolvepqaccount", {
                            block_height: registration.blockHeight,
                            tx_index: txIndex
                        });
                        if (token !== this.routeRequestId) return null;
                        registration.resolved = coerceBoolean(resolved.found);
                        if (registration.resolved && registration.viewPublicKey && registration.spendPublicKey) {
                            registration.keysMatch = normalizeHex(resolved.view_pub) === normalizeHex(registration.viewPublicKey)
                                && normalizeHex(resolved.spend_pub) === normalizeHex(registration.spendPublicKey);
                        }
                    } catch (resolveError) {}
                } catch (blockError) {}

                return transaction;
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
                var primary = styles.getPropertyValue("--primary").trim() || "#5fe29f";
                var lineColor = styles.getPropertyValue("--line").trim() || "rgba(154, 167, 178, 0.16)";
                var lineStrong = styles.getPropertyValue("--line-strong").trim() || "rgba(154, 167, 178, 0.24)";
                var textColor = styles.getPropertyValue("--text").trim() || "#e4e9ec";
                var textMuted = styles.getPropertyValue("--text-muted").trim() || "#9aa7b2";
                var textSoft = styles.getPropertyValue("--text-soft").trim() || "#7c8a94";
                var backgroundStrong = styles.getPropertyValue("--bg-card-strong").trim() || "rgba(21, 31, 36, 0.96)";
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
                                backgroundColor: "rgba(95, 226, 159, 0.12)",
                                borderWidth: 3,
                                lineTension: 0,
                                pointRadius: 2,
                                pointHoverRadius: 4,
                                pointHitRadius: 8,
                                fill: true
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
            scheduleHistoricStatsChartRender: function () {
                var _this = this;
                this.$nextTick(function () {
                    _this.renderHistoricStatsChart();
                });
            },
            destroyHistoricStatsChart: function () {
                if (this.charts.historicStats && typeof this.charts.historicStats.destroy === "function") {
                    this.charts.historicStats.destroy();
                }
                if (this.charts.historicStatsNavigator && typeof this.charts.historicStatsNavigator.destroy === "function") {
                    this.charts.historicStatsNavigator.destroy();
                }
                this.charts.historicStats = null;
                this.charts.historicStatsNavigator = null;
            },
            renderHistoricStatsChart: async function () {
                var _this = this;
                if (this.route.name !== "charts") {
                    this.destroyHistoricStatsChart();
                    return;
                }

                var model = this.historicStatsChart;
                var canvas = this.$refs.historicStatsCanvas;
                if (!model || !canvas) {
                    this.destroyHistoricStatsChart();
                    return;
                }

                try {
                    if (!window.Chart) await loadScriptOnce("/js/Chart.bundle.min.js");
                } catch (error) {
                    this.destroyHistoricStatsChart();
                    this.showToast("Could not load the chart library.", "error");
                    return;
                }

                if (!window.Chart) return;

                this.destroyHistoricStatsChart();

                var styles = window.getComputedStyle(document.documentElement);
                var primary = styles.getPropertyValue("--primary").trim() || "#5fe29f";
                var accent = styles.getPropertyValue("--accent").trim() || "#f7b548";
                var success = styles.getPropertyValue("--success").trim() || "#39d98a";
                var warning = styles.getPropertyValue("--warning").trim() || "#f6c453";
                var danger = styles.getPropertyValue("--danger").trim() || "#ff6b79";
                var lineColor = styles.getPropertyValue("--line").trim() || "rgba(154, 167, 178, 0.16)";
                var lineStrong = styles.getPropertyValue("--line-strong").trim() || "rgba(154, 167, 178, 0.24)";
                var textColor = styles.getPropertyValue("--text").trim() || "#e4e9ec";
                var textMuted = styles.getPropertyValue("--text-muted").trim() || "#9aa7b2";
                var textSoft = styles.getPropertyValue("--text-soft").trim() || "#7c8a94";
                var backgroundStrong = styles.getPropertyValue("--bg-card-strong").trim() || "rgba(21, 31, 36, 0.96)";
                var metricColors = {
                    difficulty: primary,
                    hashrate: success,
                    block_size: accent,
                    transactions_count: danger,
                    reward: warning,
                    already_generated_coins: "#9b8cff"
                };
                var chartColor = metricColors[model.metric.key] || primary;
                var context = canvas.getContext("2d");
                if (!context) return;

                this.charts.historicStats = new window.Chart(context, {
                    type: "line",
                    data: {
                        labels: model.labels,
                        datasets: [
                            {
                                label: model.metric.label,
                                yAxisID: "historicMetric",
                                data: model.points.map(function (point) {
                                    return {
                                        x: point.height,
                                        y: point.value
                                    };
                                }),
                                borderColor: chartColor,
                                backgroundColor: chartColor,
                                borderWidth: 2.5,
                                pointRadius: model.points.length > 700 ? 0 : 1.8,
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
                            display: false
                        },
                        elements: {
                            line: {
                                tension: 0
                            }
                        },
                        scales: {
                            xAxes: [
                                {
                                    id: "height",
                                    type: "linear",
                                    position: "bottom",
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
                                        minRotation: 0,
                                        callback: function (value) {
                                            return "H " + _this.formatNumber(Math.round(value));
                                        }
                                    },
                                    scaleLabel: {
                                        display: true,
                                        fontColor: textSoft,
                                        labelString: "Block height"
                                    }
                                }
                            ],
                            yAxes: [
                                {
                                    id: "historicMetric",
                                    type: "linear",
                                    position: "left",
                                    gridLines: {
                                        color: lineColor,
                                        drawBorder: false
                                    },
                                    ticks: {
                                        beginAtZero: model.metric.key === "transactions_count",
                                        fontColor: textMuted,
                                        callback: function (value) {
                                            return _this.formatHistoricStatsMetricValue(model.metric.key, null, value, true);
                                        }
                                    },
                                    scaleLabel: {
                                        display: true,
                                        fontColor: textSoft,
                                        labelString: model.metric.label
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
                                    return model.metric.label + ": " + point.displayValue;
                                },
                                footer: function (items) {
                                    var point = model.points[items[0].index];
                                    return [
                                        "Difficulty: " + _this.formatDifficulty(point.difficulty),
                                        "Transactions: " + _this.formatNumber(point.transactionsCount),
                                        "Block size: " + _this.formatBytes(point.blockSize)
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
                            _this.zoomHistoricStatsAroundHeight(point.height);
                        }
                    }
                });

                var navigatorModel = this.historicStatsNavigatorChart;
                var navigatorCanvas = this.$refs.historicStatsNavigatorCanvas;
                if (!navigatorModel || !navigatorCanvas || navigatorModel.points.length < 2) return;

                var navigatorContext = navigatorCanvas.getContext("2d");
                if (!navigatorContext) return;

                this.charts.historicStatsNavigator = new window.Chart(navigatorContext, {
                    type: "line",
                    data: {
                        labels: navigatorModel.labels,
                        datasets: [
                            {
                                label: navigatorModel.metric.label,
                                data: navigatorModel.points.map(function (point) {
                                    return {
                                        x: point.height,
                                        y: point.value
                                    };
                                }),
                                borderColor: chartColor,
                                backgroundColor: "rgba(95, 226, 159, 0.14)",
                                borderWidth: 1.5,
                                fill: true,
                                pointRadius: 0,
                                pointHitRadius: 0
                            }
                        ]
                    },
                    options: {
                        animation: {
                            duration: 0
                        },
                        events: [],
                        responsive: true,
                        maintainAspectRatio: false,
                        legend: {
                            display: false
                        },
                        elements: {
                            line: {
                                tension: 0
                            }
                        },
                        layout: {
                            padding: {
                                bottom: 3,
                                left: 0,
                                right: 0,
                                top: 3
                            }
                        },
                        scales: {
                            xAxes: [
                                {
                                    type: "linear",
                                    display: false,
                                    gridLines: {
                                        display: false,
                                        drawBorder: false
                                    },
                                    ticks: {
                                        min: 0,
                                        max: this.getTipHeight() || navigatorModel.points[navigatorModel.points.length - 1].height
                                    }
                                }
                            ],
                            yAxes: [
                                {
                                    display: false,
                                    gridLines: {
                                        display: false,
                                        drawBorder: false
                                    }
                                }
                            ]
                        },
                        tooltips: {
                            enabled: false
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
                if (this.route.name === "charts") this.scheduleHistoricStatsChartRender();
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
                    this.destroyHistoricStatsChart();
                    if (this.route.query.height !== undefined) this.home.pageHeight = coerceInteger(this.route.query.height);
                    return this.loadHomeData(token, opts.background);
                }
                this.destroyDifficultyChart();
                if (this.route.name === "charts") return this.loadHistoricStatsData(token, opts.background);
                this.destroyHistoricStatsChart();
                if (this.route.name === "block") return this.loadBlockData(token, opts.background);
                if (this.route.name === "transaction") return this.loadTransactionData(token, opts.background);
                if (this.route.name === "payment-id") return this.loadPaymentData(token, opts.background);
                if (this.route.name === "address") return this.loadAddressData(token, opts.background);
                if (this.route.name === "account-number") return this.loadAccountNumberData(token, opts.background);
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
                    var extraFields = parsePqExtra(transaction.extra.raw || "");
                    var isRegistrationType = coerceInteger(transaction.txType) === TX_TYPE_FREE_REG;
                    transaction.accountRegistration = (extraFields.registration || isRegistrationType) ? {
                        spendPublicKey: extraFields.registration ? extraFields.registration.spendPublicKey : "",
                        viewPublicKey: extraFields.registration ? extraFields.registration.viewPublicKey : "",
                        blockHeight: coerceInteger(transaction.blockIndex),
                        txIndex: null,
                        accountNumber: "",
                        confirmed: Boolean(transaction.inBlockchain),
                        resolved: null,
                        keysMatch: null
                    } : null;
                    if (transaction.accountRegistration && transaction.inBlockchain) {
                        var enrichedTransaction = await this.enrichTransactionAccountRegistration(transaction, token);
                        if (enrichedTransaction === null) return false;
                        transaction = enrichedTransaction;
                    }
                    if (token !== this.routeRequestId) return false;
                    this.txView.tx = transaction;
                    this.txView.loading = false;
                    this.activeTxTab = "outputs";
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
                if (!background) this.addressExpanded = false;
                if (!background || !this.addressView.result) this.addressView.loading = true;
                this.addressView.error = "";
                this.addressView.accountNumberError = "";
                try {
                    var address = this.route.params.address;
                    // The address is self-validating: decode bech32m locally to get
                    // the embedded ML-KEM view key and ML-DSA spend key.
                    var decoded = decodePqAddress(address);
                    var nodeConfirmed = null;
                    try {
                        var validation = await rpcCall(this.api, "validateaddress", { address: address });
                        nodeConfirmed = coerceBoolean(validation.is_valid);
                    } catch (validationError) {}
                    if (token !== this.routeRequestId) return false;

                    var accountNumber = null;
                    var accountNumberError = "";
                    if (decoded) {
                        // The on-chain registry is keyed by the identity's raw keys.
                        try {
                            var accountResult = await rpcCall(this.api, "getpqaccount", {
                                view_pub: decoded.viewPublicKey,
                                spend_pub: decoded.spendPublicKey
                            });
                            if (token !== this.routeRequestId) return false;
                            if (coerceBoolean(accountResult.registered)) {
                                var blockHeight = coerceInteger(accountResult.block_height);
                                var txIndex = coerceInteger(accountResult.tx_index);
                                accountNumber = {
                                    accountNumber: this.computeAccountNumber(blockHeight, txIndex),
                                    blockHeight: blockHeight,
                                    txIndex: txIndex
                                };
                            }
                        } catch (accountError) {
                            accountNumberError = readableError(accountError, "Could not query the account-number registry.");
                        }
                    }

                    this.addressView.result = decoded ? {
                        isValid: true,
                        network: decoded.network,
                        hrp: decoded.hrp,
                        nodeConfirmed: nodeConfirmed,
                        viewPublicKey: decoded.viewPublicKey,
                        spendPublicKey: decoded.spendPublicKey
                    } : {
                        isValid: false,
                        network: "",
                        hrp: "",
                        nodeConfirmed: nodeConfirmed,
                        viewPublicKey: "",
                        spendPublicKey: ""
                    };
                    this.addressView.accountNumber = accountNumber;
                    this.addressView.accountNumberError = accountNumberError;
                    this.addressView.loading = false;
                    return true;
                } catch (error) {
                    if (token === this.routeRequestId) {
                        this.addressView.error = readableError(error, "Could not validate that address.");
                        this.addressView.result = null;
                        this.addressView.accountNumber = null;
                        this.addressView.accountNumberError = "";
                        this.addressView.loading = false;
                    }
                    return false;
                }
            },
            loadAccountNumberData: async function (token, background) {
                if (!background || !this.accountNumberView.result) this.accountNumberView.loading = true;
                this.accountNumberView.error = "";
                try {
                    var parsed = parseAccountNumber(this.route.params.accountNumber);
                    if (!parsed) throw new Error("Enter a valid account number like 123456-0-A.");
                    if (!isValidAccountNumber(parsed.value)) throw new Error("The check character does not match — the account number has a typo.");
                    var resolved = await rpcCall(this.api, "resolvepqaccount", {
                        block_height: parsed.blockHeight,
                        tx_index: parsed.txIndex
                    });
                    if (token !== this.routeRequestId) return false;
                    this.accountNumberView.result = {
                        accountNumber: parsed.value,
                        blockHeight: parsed.blockHeight,
                        txIndex: parsed.txIndex,
                        subaddressIndex: parsed.subaddressIndex,
                        found: coerceBoolean(resolved.found),
                        viewPublicKey: resolved.view_pub || "",
                        spendPublicKey: resolved.spend_pub || ""
                    };
                    this.accountNumberView.loading = false;
                    return true;
                } catch (error) {
                    if (token === this.routeRequestId) {
                        this.accountNumberView.error = readableError(error, "Could not resolve that account number.");
                        this.accountNumberView.result = null;
                        this.accountNumberView.loading = false;
                    }
                    return false;
                }
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
                            registeredAccountNumbersCount: null,
                            rpcConnectionsCount: null,
                            incomingConnectionsCount: null,
                            outgoingConnectionsCount: null,
                            version: "",
                            startTime: null
                        };
                        try {
                            var info = await fetchNodeInfo(url);
                            item.online = true;
                            item.height = Math.max((coerceInteger(info.height) || 0) - 1, 0);
                            item.lastKnownBlockIndex = coerceInteger(info.last_known_block_index);
                            item.topBlockHash = info.top_block_hash || "";
                            item.difficulty = info.difficulty;
                            item.altBlocksCount = info.alt_blocks_count;
                            item.registeredAccountNumbersCount = info.registered_account_numbers_count;
                            item.rpcConnectionsCount = coerceInteger(info.rpc_connections_count);
                            item.incomingConnectionsCount = coerceInteger(info.incoming_connections_count);
                            item.outgoingConnectionsCount = coerceInteger(info.outgoing_connections_count);
                            item.version = info.version || "";
                            item.startTime = coerceInteger(info.start_time);
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
            loadHistoricStatsData: async function (token, background) {
                var hasExistingPoints = this.historicStats.points && this.historicStats.points.length;
                if (!background || !hasExistingPoints) this.historicStats.loading = true;
                this.historicStats.error = "";

                try {
                    await this.ensureStats();
                    if (token !== this.routeRequestId) return false;

                    var tipHeight = this.getTipHeight();
                    if (tipHeight === null) throw new Error("Could not determine current chain height.");

                    var requestedRange = this.getHistoricStatsRange(tipHeight);
                    var result = null;
                    var rawStats = [];
                    var source = "sparse";
                    var requestedPoints = 0;
                    var sampleStep = 0;

                    if (requestedRange && requestedRange.count <= HISTORIC_STATS_RANGE_LIMIT) {
                        result = await rpcCall(this.api, "getstatsinrange", {
                            start_height: requestedRange.start,
                            end_height: requestedRange.end
                        }, { bigIntFields: ["already_generated_coins"] });
                        rawStats = result.stats || [];
                        if (rawStats.length > HISTORIC_STATS_MAX_POINTS) rawStats = thinHistoricStats(rawStats);
                        source = "range";
                        requestedPoints = requestedRange.count;
                        sampleStep = rawStats.length > 1
                            ? Math.max(1, Math.round((requestedRange.end - requestedRange.start) / Math.max(rawStats.length - 1, 1)))
                            : 0;
                    } else if (requestedRange) {
                        var rangeHeights = buildHistoricRangeSampleHeights(requestedRange.start, requestedRange.end);
                        result = await rpcCall(this.api, "getstatsbyheights", { heights: rangeHeights }, { bigIntFields: ["already_generated_coins"] });
                        rawStats = result.stats || [];
                        source = "sparse-zoom";
                        requestedPoints = rangeHeights.length;
                        sampleStep = rangeHeights.length > 1 ? rangeHeights[1] - rangeHeights[0] : 0;
                    } else {
                        var heights = buildHistoricSampleHeights(tipHeight);
                        requestedPoints = heights.length;
                        sampleStep = heights.length > 1 ? heights[1] - heights[0] : 0;

                        try {
                            result = await rpcCall(this.api, "getstatsbyheights", { heights: heights }, { bigIntFields: ["already_generated_coins"] });
                            rawStats = result.stats || [];
                        } catch (sparseError) {
                            var rangeSize = Math.min(HISTORIC_STATS_RANGE_LIMIT, tipHeight + 1);
                            var startHeight = Math.max(tipHeight - rangeSize + 1, 0);
                            result = await rpcCall(this.api, "getstatsinrange", {
                                start_height: startHeight,
                                end_height: tipHeight
                            }, { bigIntFields: ["already_generated_coins"] });
                            rawStats = thinHistoricStats(result.stats || []);
                            source = "range-fallback";
                            requestedPoints = rangeSize;
                            sampleStep = rawStats.length > 1
                                ? Math.max(1, Math.round((tipHeight - startHeight) / Math.max(rawStats.length - 1, 1)))
                                : 0;
                        }
                    }

                    if (token !== this.routeRequestId) return false;

                    var points = normalizeHistoricStats(rawStats);
                    if (!points.length) throw new Error("No historical stats returned by the node.");

                    this.historicStats.points = points;
                    if (source === "sparse" || source === "range-fallback" || !this.historicStats.navigatorPoints.length) {
                        this.historicStats.navigatorPoints = points;
                    }
                    this.historicStats.source = source;
                    this.historicStats.sampleStep = sampleStep;
                    this.historicStats.requestedPoints = requestedPoints;
                    this.historicStats.requestDuration = result && Number.isFinite(Number(result.duration)) ? Number(result.duration) : null;
                    this.historicStats.loadedAt = Math.floor(Date.now() / 1000);
                    this.historicStats.loading = false;
                    this.scheduleHistoricStatsChartRender();
                    return true;
                } catch (error) {
                    if (token === this.routeRequestId) {
                        this.historicStats.error = readableError(error, "Could not load historical stats.");
                        this.historicStats.points = [];
                        this.destroyHistoricStatsChart();
                        this.historicStats.loading = false;
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
                    this.showToast("Enter a block height, hash, payment ID, address, or account number.", "error");
                    return;
                }
                if (isPqAddressCandidate(query)) {
                    if (!decodePqAddress(query)) {
                        this.showToast("That looks like a Discrete address, but the bech32m checksum is invalid.", "error");
                        return;
                    }
                    await this.goTo({ name: "address", params: { address: query.toLowerCase() } });
                    return;
                }
                if (isAccountNumberCandidate(query)) {
                    if (!isValidAccountNumber(query)) {
                        this.showToast("Invalid account number — check character mismatch.", "error");
                        return;
                    }
                    await this.goTo({ name: "account-number", params: { accountNumber: normalizeAccountNumber(query) } });
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
            validateAddressToolSubmit: async function () {
                this.validateTool.error = "";
                this.validateTool.result = null;
                var input = this.validateTool.address.trim();
                if (!input) {
                    this.validateTool.error = "Enter an address or account number to validate.";
                    return;
                }
                this.validateTool.loading = true;
                try {
                    // Both forms are self-validating; decode locally and use the
                    // node's validateaddress as a network-side confirmation.
                    var decoded = decodePqAddress(input);
                    if (decoded) {
                        this.validateTool.result = {
                            isValid: true,
                            form: decoded.network + " address (bech32m, " + decoded.hrp + ")",
                            openRoute: { name: "address", params: { address: input.toLowerCase() } }
                        };
                        return;
                    }
                    if (isAccountNumberCandidate(input)) {
                        var accountValid = isValidAccountNumber(input);
                        this.validateTool.result = {
                            isValid: accountValid,
                            form: "account number",
                            openRoute: accountValid ? { name: "account-number", params: { accountNumber: normalizeAccountNumber(input) } } : null
                        };
                        return;
                    }
                    var result = await rpcCall(this.api, "validateaddress", { address: input });
                    this.validateTool.result = {
                        isValid: coerceBoolean(result.is_valid),
                        form: "address",
                        openRoute: null
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
            isOutputHighlighted: function (output, index) {
                return this.route.query.highlight !== undefined && String(this.route.query.highlight) === String(index);
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
            this.destroyHistoricStatsChart();
            if (this.toastTimerId) window.clearTimeout(this.toastTimerId);
            if (this.clockTimerId) window.clearInterval(this.clockTimerId);
            if (this.pollTimerId) window.clearInterval(this.pollTimerId);
            if (this.popstateHandler) window.removeEventListener("popstate", this.popstateHandler);
            if (this.mobileHeaderScrollHandler) window.removeEventListener("scroll", this.mobileHeaderScrollHandler);
            if (this.mobileHeaderResizeHandler) window.removeEventListener("resize", this.mobileHeaderResizeHandler);
        }
    }).mount("#app");
})();
