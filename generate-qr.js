const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const url = 'https://web20rewards.onrender.com/';
const outputPath = path.join(__dirname, 'loyalty-qr-code.png');

// Generate QR code
QRCode.toFile(outputPath, url, {
    width: 1000,
    margin: 2,
    color: {
        dark: '#4169E1',  // Royal blue to match your brand
        light: '#FFFFFF'
    }
}, function (err) {
    if (err) {
        console.error('Error generating QR code:', err);
    } else {
        console.log('✓ QR code generated successfully!');
        console.log('✓ Location:', outputPath);
        console.log('✓ URL encoded:', url);
        console.log('\nYou can now:');
        console.log('1. Open the file to view it');
        console.log('2. Print it at any size');
        console.log('3. Display it at your location for customers to scan');
    }
});
