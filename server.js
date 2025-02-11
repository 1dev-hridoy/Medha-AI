require('dotenv').config();
const express = require('express');
const path = require('path');
const multer = require('multer');
const axios = require('axios');
const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));

// Multer configuration
const storage = multer.memoryStorage();
const upload = multer({ 
    storage: storage,
    limits: {
        fileSize: 5 * 1024 * 1024 // 5MB limit
    }
});

// Conversation history storage
const conversations = new Map();

// Gemini API configuration
const GEMINI_API = {
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/models',
    models: {
        vision: 'gemini-pro-vision',
        chat: 'gemini-pro'
    }
};

// Utility function for delay
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function callGeminiAPI(payload, isImageRequest = false) {
    const model = isImageRequest ? GEMINI_API.models.vision : GEMINI_API.models.chat;
    const url = `${GEMINI_API.baseURL}/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
    
    try {
        const response = await axios.post(url, payload, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 30000
        });
        
        if (!response.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
            throw new Error('Invalid response format from Gemini API');
        }
        
        return response.data.candidates[0].content.parts[0].text;
    } catch (error) {
        if (error.response?.status === 503) {
            throw new Error('SERVICE_OVERLOADED');
        }
        console.error(`API Error (${model}):`, error.response?.data || error.message);
        throw error;
    }
}

async function retryWithBackoff(fn, maxRetries = 3) {
    let lastError;
    
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            
            if (i === maxRetries - 1) {
                break;
            }

            if (error.message === 'SERVICE_OVERLOADED') {
                const waitMs = Math.min(1000 * Math.pow(2, i), 5000);
                console.log(`Service busy, waiting ${waitMs}ms before retry ${i + 1}/${maxRetries}...`);
                await delay(waitMs);
            } else {
                throw error; // Don't retry other types of errors
            }
        }
    }
    
    throw lastError;
}

// Route for the home page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API endpoint for Gemini
app.post('/api/chat', upload.single('image'), async (req, res) => {
    try {
        const { message, sessionId } = req.body;
        const imageFile = req.file;
        
        if (!message && !imageFile) {
            return res.status(400).json({ 
                error: 'Please provide a message or image'
            });
        }

        // Get conversation history
        let conversationHistory = conversations.get(sessionId) || [];

        // Prepare payload
        let payload = {
            contents: [{
                role: 'user',
                parts: [{ text: message || '' }]
            }]
        };

        // Add image if present
        if (imageFile) {
            payload.contents[0].parts.push({
                inline_data: {
                    mime_type: imageFile.mimetype,
                    data: imageFile.buffer.toString('base64')
                }
            });
        }

        // Call API with retries
        const botResponse = await retryWithBackoff(() => 
            callGeminiAPI(payload, !!imageFile)
        );

        // Update conversation history
        conversationHistory.push(
            { role: 'user', parts: [{ text: message || '' }] },
            { role: 'model', parts: [{ text: botResponse }] }
        );

        // Limit history
        while (conversationHistory.length > 20) {
            conversationHistory.shift();
        }

        conversations.set(sessionId, conversationHistory);
        res.json({ response: botResponse });

    } catch (error) {
        console.error('Chat Error:', error.message);
        
        const errorResponse = {
            error: 'An error occurred while processing your request',
            retryAfter: 5
        };

        if (error.message === 'SERVICE_OVERLOADED') {
            res.status(503).json({
                ...errorResponse,
                error: 'The service is currently busy. Please try again in a few moments.'
            });
        } else if (error.response?.status === 400) {
            res.status(400).json({
                ...errorResponse,
                error: 'Invalid request. Please check your input and try again.'
            });
        } else {
            res.status(500).json(errorResponse);
        }
    }
});

app.listen(port, () => {
    console.log(`Server is running at http://localhost:${port}`);
});