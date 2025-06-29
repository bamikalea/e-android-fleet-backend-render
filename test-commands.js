const axios = require('axios');

const BASE_URL = 'https://e-android-fleet-backend-render.onrender.com';
const DEVICE_ID = '13f15b0094dcc44a';

async function testCommands() {
    console.log('🚗 Testing Fleet Management Commands...\n');

    try {
        // Test 1: Check server status
        console.log('1. Testing server status...');
        const statusResponse = await axios.get(`${BASE_URL}/api/status`);
        console.log('✅ Server is online:', statusResponse.data.status);
        console.log('   Connected devices:', statusResponse.data.connectedDevices);

        // Test 2: Check device registration
        console.log('\n2. Testing device registration...');
        const devicesResponse = await axios.get(`${BASE_URL}/api/dashcams`);
        const device = devicesResponse.data.find(d => d.deviceId === DEVICE_ID);
        if (device) {
            console.log('✅ Device is registered:', device.deviceId);
            console.log('   Status:', device.status);
            console.log('   Last seen:', device.lastSeen);
        } else {
            console.log('❌ Device not found');
            return;
        }

        // Test 3: Send getStatus command
        console.log('\n3. Testing getStatus command...');
        const statusCommand = await axios.post(`${BASE_URL}/api/dashcams/${DEVICE_ID}/commands`, {
            command: 'getStatus'
        });
        console.log('✅ Status command queued:', statusCommand.data.message);
        console.log('   Command ID:', statusCommand.data.commandId);

        // Test 4: Send takePhoto command
        console.log('\n4. Testing takePhoto command...');
        const photoCommand = await axios.post(`${BASE_URL}/api/dashcams/${DEVICE_ID}/commands`, {
            command: 'takePhoto'
        });
        console.log('✅ Photo command queued:', photoCommand.data.message);
        console.log('   Command ID:', photoCommand.data.commandId);

        // Test 5: Send TTS command
        console.log('\n5. Testing TTS command...');
        const ttsCommand = await axios.post(`${BASE_URL}/api/dashcams/${DEVICE_ID}/commands`, {
            command: 'playTTS',
            parameters: {
                message: 'Test message from server'
            }
        });
        console.log('✅ TTS command queued:', ttsCommand.data.message);
        console.log('   Command ID:', ttsCommand.data.commandId);

        // Test 6: Send getLocation command
        console.log('\n6. Testing getLocation command...');
        const locationCommand = await axios.post(`${BASE_URL}/api/dashcams/${DEVICE_ID}/commands`, {
            command: 'getLocation'
        });
        console.log('✅ Location command queued:', locationCommand.data.message);
        console.log('   Command ID:', locationCommand.data.commandId);

        // Test 7: Check media endpoints
        console.log('\n7. Testing media endpoints...');
        const mediaResponse = await axios.get(`${BASE_URL}/api/media`);
        console.log('✅ Media endpoint accessible');
        console.log('   Files available:', mediaResponse.data.files.length);

        // Test 8: Check device commands endpoint
        console.log('\n8. Testing device commands polling...');
        const commandsResponse = await axios.get(`${BASE_URL}/api/dashcams/${DEVICE_ID}/commands`);
        console.log('✅ Commands endpoint accessible');
        console.log('   Pending commands:', commandsResponse.data.commands.length);

        console.log('\n🎉 All tests completed successfully!');
        console.log('\n📱 Next steps:');
        console.log('   1. Open the UI at: https://e-android-fleet-backend-render.onrender.com');
        console.log('   2. Check that the device appears in the dashboard');
        console.log('   3. Try sending commands from the UI');
        console.log('   4. Check the media gallery for uploaded files');

    } catch (error) {
        console.error('❌ Test failed:', error.message);
        if (error.response) {
            console.error('   Status:', error.response.status);
            console.error('   Data:', error.response.data);
        }
    }
}

testCommands(); 