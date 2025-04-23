#!/usr/bin/env node

import {
    createFungible,
    mplTokenMetadata,
} from '@metaplex-foundation/mpl-token-metadata';
import {
    createTokenIfMissing,
    findAssociatedTokenPda,
    getSplAssociatedTokenProgramId,
    mintTokensTo,
    mplToolbox,
} from '@metaplex-foundation/mpl-toolbox';
import {
    createSignerFromKeypair,
    keypairIdentity,
    percentAmount,
} from '@metaplex-foundation/umi';
import { base58 } from '@metaplex-foundation/umi/serializers';
import { AuthorityType, setAuthority as setTokenAuthority } from '@solana/spl-token';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import inquirer from 'inquirer';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import FormData from 'form-data';

dotenv.config();

async function getMintAddress() {
    const mintKeypair = Keypair.generate();
    return {
        publicKey: mintKeypair.publicKey.toBase58(),
        privateKey: Buffer.from(mintKeypair.secretKey).toString('base64'),
    };
}

async function uploadImageToIPFS({ imagePath, name, symbol, description, twitter, website }) {
    try {
        console.log('Step 8: Uploading image and metadata to IPFS...');
        const fileBuffer = fs.readFileSync(imagePath);
        const formData = new FormData();
        formData.append('file', fileBuffer, path.basename(imagePath));
        formData.append('name', name);
        formData.append('symbol', symbol);
        formData.append('description', description || '');
        formData.append('twitter', twitter || '');
        formData.append('website', website || '');
        formData.append('showName', 'true');
        formData.append('createdOn', 'https://pump.fun');

        const response = await fetch('https://up.supapump.fun/api/ipfs', {
            method: 'POST',
            body: formData,
            headers: formData.getHeaders(), // Ensure Content-Type with boundary is set
        });

        if (!response.ok) {
            throw new Error(`IPFS upload failed: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        if (!data.metadataUri) {
            throw new Error('IPFS response did not contain a valid metadata URI');
        }

        console.log(`Metadata uploaded successfully! IPFS Metadata URI: ${data.metadataUri}`);
        return data.metadataUri;
    } catch (error) {
        console.error('Error uploading to IPFS:', error.message);
        throw error;
    }
}

async function createToken({ name, symbol, uri, decimals, supply, disableMintAuthority, disableFreezeAuthority, disableUpdateAuthority, rpcUrl }) {
    try {
        const umi = createUmi(rpcUrl)
            .use(mplTokenMetadata())
            .use(mplToolbox());

        const keypairSecret = new Uint8Array(JSON.parse(process.env.SOLANA_WALLET_SECRET));
        const keypair = umi.eddsa.createKeypairFromSecretKey(keypairSecret);
        umi.use(keypairIdentity(keypair));

        const mintWallet = await getMintAddress();
        const mintSecret = Buffer.from(mintWallet.privateKey, 'base64');
        const mintKeypair = umi.eddsa.createKeypairFromSecretKey(mintSecret);
        const mintSigner = createSignerFromKeypair(umi, mintKeypair);

        console.log('Step 9: Creating token instructions...');
        const createFungibleIx = createFungible(umi, {
            mint: mintSigner,
            name,
            symbol,
            uri,
            sellerFeeBasisPoints: percentAmount(0),
            decimals,
            isMutable: !disableUpdateAuthority,
            isCollection: false,
        });

        const createTokenIx = createTokenIfMissing(umi, {
            mint: mintSigner.publicKey,
            owner: umi.identity.publicKey,
            ataProgram: getSplAssociatedTokenProgramId(umi),
        });

        const mintTokensIx = mintTokensTo(umi, {
            mint: mintSigner.publicKey,
            token: findAssociatedTokenPda(umi, {
                mint: mintSigner.publicKey,
                owner: umi.identity.publicKey,
            }),
            amount: BigInt(Number(supply) * 10 ** decimals),
        });

        console.log('Step 10: Sending transaction...');
        const tx = await createFungibleIx
            .add(createTokenIx)
            .add(mintTokensIx)
            .sendAndConfirm(umi);

        const payerKeypair = Keypair.fromSecretKey(keypairSecret);
        const connection = new Connection(rpcUrl, 'confirmed');

        let disableMintAuthTx, disableFreezeAuthTx, disableUpdateAuthTx;

        if (disableMintAuthority) {
            console.log('Step 11: Disabling mint authority...');
            disableMintAuthTx = await setTokenAuthority(
                connection,
                payerKeypair,
                new PublicKey(mintSigner.publicKey),
                payerKeypair,
                AuthorityType.MintTokens,
                null
            );
        }

        if (disableFreezeAuthority) {
            console.log('Step 12: Disabling freeze authority...');
            disableFreezeAuthTx = await setTokenAuthority(
                connection,
                payerKeypair,
                new PublicKey(mintSigner.publicKey),
                payerKeypair,
                AuthorityType.FreezeAccount,
                null
            );
        }

        const signature = base58.deserialize(tx.signature)[0];

        console.log('\n🎉 Transaction Complete!');
        console.log('View Transaction:');
        console.log(`https://solscan.io/tx/${signature}${rpcUrl === 'https://api.devnet.solana.com' ? '?cluster=devnet' : ''}`);
        console.log('View Token:');
        console.log(`https://solscan.io/token/${mintSigner.publicKey}${rpcUrl === 'https://api.devnet.solana.com' ? '?cluster=devnet' : ''}`);
        console.log(`Token Address: ${mintSigner.publicKey}`);
        console.log(`Signature: ${signature}`);
        console.log(`Metadata URI: ${uri}`);
        if (disableMintAuthTx) console.log(`Disabled mint auth: https://solscan.io/tx/${disableMintAuthTx}${rpcUrl === 'https://api.devnet.solana.com' ? '?cluster=devnet' : ''}`);
        if (disableFreezeAuthTx) console.log(`Disabled freeze auth: https://solscan.io/tx/${disableFreezeAuthTx}${rpcUrl === 'https://api.devnet.solana.com' ? '?cluster=devnet' : ''}`);

        console.log('\n✅ Token creation completed successfully. Exiting...');
        process.exit(0);
    } catch (error) {
        console.error('❌ Error creating token:', error.message);
        process.exit(1);
    }
}

async function checkAndCreateWallet(rpcUrl) {
    const walletPath = path.join(process.cwd(), 'wallet.json');
    const connection = new Connection(rpcUrl, 'confirmed');

    if (!fs.existsSync(walletPath)) {
        console.log('Creating new wallet.json file...');
        const keypair = Keypair.generate();
        // Store just the secret key as a buffer
        fs.writeFileSync(walletPath, JSON.stringify(Array.from(keypair.secretKey)));
        console.log('✅ New wallet created and saved to wallet.json');
        console.log(`Public Key: ${keypair.publicKey.toBase58()}`);
        console.log('Please fund this wallet with SOL before proceeding.\n');
        return keypair;
    } else {
        console.log('✅ Using existing wallet.json');
        const secretKey = new Uint8Array(JSON.parse(fs.readFileSync(walletPath, 'utf8')));
        const keypair = Keypair.fromSecretKey(secretKey);
        return keypair;
    }
}

async function checkWalletBalance(connection, publicKey) {
    const balance = await connection.getBalance(new PublicKey(publicKey));
    const solBalance = balance / 1e9; // Convert lamports to SOL
    return solBalance;
}

async function stepper() {
    console.log('Welcome to the Solana Token CLI! 🚀');
    console.log('Follow the steps to create your fungible token.\n');

    const rpcOptions = [
        { name: 'Devnet (https://api.devnet.solana.com)', value: 'https://api.devnet.solana.com' },
        { name: 'Mainnet (https://api.mainnet-beta.solana.com)', value: 'https://api.mainnet-beta.solana.com' },
        { name: 'Custom RPC URL', value: 'custom' },
    ];

    const { rpcChoice, customRpcUrl } = await inquirer.prompt([
        {
            type: 'list',
            name: 'rpcChoice',
            message: 'Step 1: Select the Solana RPC endpoint:',
            choices: rpcOptions,
            default: 'https://api.devnet.solana.com',
        },
        {
            type: 'input',
            name: 'customRpcUrl',
            message: 'Enter your custom RPC URL (e.g., https://your-rpc-url.com):',
            when: (answers) => answers.rpcChoice === 'custom',
            validate: (input) => {
                if (!input.trim().startsWith('http')) return 'Please enter a valid URL starting with http or https!';
                return true;
            },
        },
    ]);

    const rpcUrl = rpcChoice === 'custom' ? customRpcUrl : rpcChoice;
    const connection = new Connection(rpcUrl, 'confirmed');

    // Check and create wallet if needed
    const keypair = await checkAndCreateWallet(rpcUrl);
    const publicKey = keypair.publicKey.toBase58();

    // Check wallet balance
    const balance = await checkWalletBalance(connection, publicKey);
    console.log(`\nCurrent wallet balance: ${balance} SOL`);

    if (balance < 0.1) {
        console.log('\n⚠️ Warning: Your wallet balance is low!');
        console.log('Please send at least 0.1 SOL to this address:');
        console.log(publicKey);
        console.log('\nPress Enter to continue once you have funded the wallet...');
        await inquirer.prompt([{ type: 'input', name: 'continue', message: '' }]);

        // Recheck balance
        const newBalance = await checkWalletBalance(connection, publicKey);
        if (newBalance < 0.1) {
            console.error('❌ Insufficient balance. Please fund your wallet and try again.');
            process.exit(1);
        }
    }

    // Set the wallet as the environment variable for token creation
    process.env.SOLANA_WALLET_SECRET = JSON.stringify(Array.from(keypair.secretKey));

    const answers = await inquirer.prompt([
        {
            type: 'input',
            name: 'name',
            message: 'Step 2: Enter the token name (e.g., My Token):',
            validate: (input) => input.trim() !== '' || 'Token name cannot be empty!',
        },
        {
            type: 'input',
            name: 'symbol',
            message: 'Step 3: Enter the token symbol (e.g., MTK):',
            validate: (input) => input.trim() !== '' || 'Token symbol cannot be empty!',
        },
        {
            type: 'input',
            name: 'decimals',
            message: 'Step 4: Enter the number of decimal places (e.g., 6):',
            default: '6',
            validate: (input) => {
                const num = parseInt(input);
                if (isNaN(num) || num < 0) return 'Decimals must be a non-negative integer!';
                return true;
            },
        },
        {
            type: 'input',
            name: 'supply',
            message: 'Step 5: Enter the total token supply (e.g., 1000000000):',
            default: '1000000000',
            validate: (input) => {
                const num = parseFloat(input);
                if (isNaN(num) || num <= 0) return 'Supply must be a positive number!';
                return true;
            },
        },
        {
            type: 'input',
            name: 'imagePath',
            message: 'Step 6: Enter the path to your token image file (e.g., token.jpg):',
            validate: (input) => {
                if (!fs.existsSync(input)) {
                    return 'File does not exist! Please provide a valid file path.';
                }
                return true;
            },
        },
        {
            type: 'input',
            name: 'description',
            message: 'Step 7: Enter a description for your token (optional):',
            default: '',
        },
        {
            type: 'input',
            name: 'twitter',
            message: 'Step 8: Enter a Twitter handle (optional, e.g., https://x.com/metasal_):',
            default: '',
        },
        {
            type: 'input',
            name: 'website',
            message: 'Step 9: Enter a website URL (optional, e.g., https://metasal.xyz):',
            default: '',
        },
        {
            type: 'confirm',
            name: 'disableMintAuthority',
            message: 'Step 10: Disable mint authority? (Prevents further minting)',
            default: true,
        },
        {
            type: 'confirm',
            name: 'disableFreezeAuthority',
            message: 'Step 11: Disable freeze authority? (Prevents freezing accounts)',
            default: true,
        },
        {
            type: 'confirm',
            name: 'disableUpdateAuthority',
            message: 'Step 12: Disable update authority? (Prevents metadata updates)',
            default: true,
        },
        {
            type: 'confirm',
            name: 'confirm',
            message: 'Ready to upload the image/metadata and create the token?',
            default: true,
        },
    ]);

    if (!answers.confirm) {
        console.log('Token creation cancelled. 💩');
        process.exit(0);
    }

    console.log('\nProcessing token creation with the following details:');
    console.log(`RPC URL: ${rpcUrl}`);
    console.log(`Name: ${answers.name}`);
    console.log(`Symbol: ${answers.symbol}`);
    console.log(`Decimals: ${answers.decimals}`);
    console.log(`Supply: ${answers.supply}`);
    console.log(`Image Path: ${answers.imagePath}`);
    console.log(`Description: ${answers.description || 'None'}`);
    console.log(`Twitter: ${answers.twitter || 'None'}`);
    console.log(`Website: ${answers.website || 'None'}`);
    console.log(`Disable Mint Authority: ${answers.disableMintAuthority}`);
    console.log(`Disable Freeze Authority: ${answers.disableFreezeAuthority}`);
    console.log(`Disable Update Authority: ${answers.disableUpdateAuthority}\n`);

    // Upload image and metadata to IPFS
    const metadataUri = await uploadImageToIPFS({
        imagePath: answers.imagePath,
        name: answers.name,
        symbol: answers.symbol,
        description: answers.description,
        twitter: answers.twitter,
        website: answers.website,
    });

    await createToken({
        name: answers.name,
        symbol: answers.symbol,
        uri: metadataUri,
        decimals: parseInt(answers.decimals),
        supply: parseFloat(answers.supply),
        disableMintAuthority: answers.disableMintAuthority,
        disableFreezeAuthority: answers.disableFreezeAuthority,
        disableUpdateAuthority: answers.disableUpdateAuthority,
        rpcUrl,
    });
}

stepper().catch((error) => {
    console.error('❌ Error in stepper:', error.message);
    process.exit(1);
});
