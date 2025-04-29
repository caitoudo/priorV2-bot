import blessed from "blessed";
import chalk from "chalk";
import figlet from "figlet";
import { ethers } from "ethers";
import fs from "fs";
import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";

const RPC_URL = "https://sepolia.base.org";
const USDC_ADDRESS = "0xdB07b0b4E88D9D5A79A08E91fEE20Bb41f9989a2";
const PRIOR_ADDRESS = "0xeFC91C5a51E8533282486FA2601dFfe0a0b16EDb";
const ROUTER_ADDRESS = "0x8957e1988905311EE249e679a29fc9deCEd4D910";
const FAUCET_ADDRESS = "0xa206dC56F1A56a03aEa0fCBB7c7A62b5bE1Fe419";
const FAUCET_API_URL = "https://priortestnet.xyz/api/faucet/claim";
const API_URL = "https://priortestnet.xyz/api/swap";

const SWAP_PRIOR_TO_USDC_DATA = "0x8ec7baf1000000000000000000000000000000000000000000000000016345785d8a0000";
const SWAP_USDC_TO_PRIOR_DATA = "0xea0e43580000000000000000000000000000000000000000000000000000000000030d40";

let walletInfo = {
  address: "N/A",
  balanceETH: "0.00",
  balancePrior: "0.00",
  balanceUSDC: "0.00",
  activeAccount: "N/A",
  cycleCount: 0,
  nextCycle: "N/A"
};
let transactionLogs = [];
let swapRunning = false;
let shouldStop = false;
let loopCount = 0;
let dailySwapInterval = null;
let privateKeys = [];
let proxies = [];
let currentCycle = 0;
let selectedWalletIndex = 0;
let currentSwapIteration = 0;
let loadingSpinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const borderBlinkColors = ["cyan", "blue", "magenta", "red", "yellow", "green"];
let borderBlinkIndex = 0;
let blinkCounter = 0;
let spinnerIndex = 0;
let nonceTracker = {};
let hasLoggedSleepInterrupt = false;

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)"
];

const FAUCET_ABI = [
  "function claim() external",
  "function lastClaimTime(address) view returns (uint256)",
  "function claimInterval() view returns (uint256)"
];

function getShortAddress(address) {
  return address ? address.slice(0, 6) + "..." + address.slice(-4) : "N/A";
}

function addLog(message, type = "info") {
  const timestamp = new Date().toLocaleTimeString();
  let coloredMessage;
  switch (type) {
    case "error":
      coloredMessage = chalk.red(message);
      break;
    case "success":
      coloredMessage = chalk.green(message);
      break;
    case "wait":
      coloredMessage = chalk.yellow(message);
      break;
    default:
      coloredMessage = chalk.white(message);
  }
  transactionLogs.push(`{bright-cyan-fg}[{/bright-cyan-fg} {bold}{grey-fg}${timestamp}{/grey-fg}{/bold} {bright-cyan-fg}]{/bright-cyan-fg} {bold}${coloredMessage}{/bold}`);
  updateLogs();
}

function getShortHash(hash) {
  return hash.slice(0, 6) + "..." + hash.slice(-4);
}

function clearTransactionLogs() {
  transactionLogs = [];
  addLog("Transaction logs cleared.", "success");
  updateLogs();
}

function getApiHeaders(customHeaders = {}) {
  return {
    "Content-Type": "application/json", 
    "Accept-Encoding": "gzip, deflate, br",
    "Referer": "https://testnetpriorprotocol.xyz/",
    "Origin": "https://testnetpriorprotocol.xyz",
    ...customHeaders 
  };
}

async function sleep(ms) {
  if (shouldStop) {
    if (!hasLoggedSleepInterrupt) {
      addLog("Stopped Procces Succesfully.", "info");
      hasLoggedSleepInterrupt = true;
    }
    return;
  }
  return new Promise(resolve => {
    const timeout = setTimeout(() => {
      clearInterval(checkStop);
      resolve();
    }, ms);
    const checkStop = setInterval(() => {
      if (shouldStop) {
        clearTimeout(timeout);
        clearInterval(checkStop);
        if (!hasLoggedSleepInterrupt) {
          addLog("Stopped Procces Succesfully.", "info");
          hasLoggedSleepInterrupt = true;
        }
        resolve();
      }
    }, 100);
  });
}

function loadPrivateKeys() {
  try {
    const data = fs.readFileSync("pk.txt", "utf8");
    privateKeys = data.split("\n").map(key => key.trim()).filter(key => key.match(/^(0x)?[0-9a-fA-F]{64}$/));
    if (privateKeys.length === 0) throw new Error("No valid private keys in pk.txt");
    addLog(`Loaded ${privateKeys.length} private keys from pk.txt`, "success");
  } catch (error) {
    addLog(`Failed to load private keys: ${error.message}`, "error");
    privateKeys = [];
  }
}

function loadProxies() {
  try {
    const data = fs.readFileSync("proxy.txt", "utf8");
    proxies = data.split("\n").map(proxy => proxy.trim()).filter(proxy => proxy);
    if (proxies.length === 0) throw new Error("No proxies found in proxy.txt");
    addLog(`Loaded ${proxies.length} proxies from proxy.txt`, "success");
  } catch (error) {
    addLog(`Failed to load proxies: ${error.message}`, "error");
    proxies = [];
  }
}

function createAgent(proxyUrl) {
  if (!proxyUrl) return null;
  if (proxyUrl.startsWith("socks")) {
    return new SocksProxyAgent(proxyUrl);
  } else {
    return new HttpsProxyAgent(proxyUrl);
  }
}

function getProviderWithProxy(proxyUrl) {
  const agent = createAgent(proxyUrl);
  const fetchOptions = agent ? { agent } : {};
  return new ethers.JsonRpcProvider(RPC_URL, undefined, { fetchOptions });
}

async function makeApiRequest(method, url, data, proxyUrl, customHeaders = {}, maxRetries = 3, retryDelay = 2000) {
  let lastError = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const agent = createAgent(proxyUrl);
      const config = {
        method,
        url,
        data,
        headers: getApiHeaders(customHeaders),
        ...(agent ? { httpsAgent: agent, httpAgent: agent } : {}),
        timeout: 10000
      };
      const response = await axios(config);
      return response.data;
    } catch (error) {
      lastError = error;
      let errorMessage = `Attempt ${attempt}/${maxRetries} failed for API request to ${url}`;
      if (error.response) {
        errorMessage += `: HTTP ${error.response.status} - ${JSON.stringify(error.response.data)}`;
      } else if (error.request) {
        errorMessage += `: No response received from API`;
      } else {
        errorMessage += `: ${error.message}`;
      }
      addLog(errorMessage, "error");

      if (attempt < maxRetries) {
        addLog(`Retrying API request to ${url} in ${retryDelay/1000} seconds...`, "wait");
        await sleep(retryDelay);
      }
    }
  }

  let finalErrorMessage = `Failed to make API request to ${url} after ${maxRetries} attempts`;
  if (lastError.response) {
    finalErrorMessage += `: HTTP ${lastError.response.status} - ${JSON.stringify(lastError.response.data)}`;
  } else if (lastError.request) {
    finalErrorMessage += `: No response received from API`;
  } else {
    finalErrorMessage += `: ${lastError.message}`;
  }
  throw new Error(finalErrorMessage);
}

async function updateWalletData() {
  const walletDataPromises = privateKeys.map(async (privateKey, i) => {
    try {
      const proxyUrl = proxies[i % proxies.length] || null;
      const provider = getProviderWithProxy(proxyUrl);
      const wallet = new ethers.Wallet(privateKey, provider);
      const [ethBalance, balancePrior, balanceUSDC] = await Promise.all([
        provider.getBalance(wallet.address).catch(() => 0),
        new ethers.Contract(PRIOR_ADDRESS, ERC20_ABI, provider).balanceOf(wallet.address).catch(() => 0),
        new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider).balanceOf(wallet.address).catch(() => 0)
      ]);

      const formattedEntry = `${i === selectedWalletIndex ? "→ " : "  "}${getShortAddress(wallet.address)}   ${Number(ethers.formatEther(ethBalance)).toFixed(4).padEnd(8)} ${Number(ethers.formatEther(balancePrior)).toFixed(2).padEnd(8)}${Number(ethers.formatUnits(balanceUSDC, 6)).toFixed(2).padEnd(8)}`;

      if (i === selectedWalletIndex) {
        walletInfo.address = wallet.address;
        walletInfo.activeAccount = `Account ${i + 1}`;
        walletInfo.balanceETH = Number(ethers.formatEther(ethBalance)).toFixed(4);
        walletInfo.balancePrior = Number(ethers.formatEther(balancePrior)).toFixed(2);
        walletInfo.balanceUSDC = Number(ethers.formatUnits(balanceUSDC, 6)).toFixed(2);
      }

      return formattedEntry;
    } catch (error) {
      addLog(`Failed to fetch wallet data for account #${i + 1}: ${error.message}`, "error");
      return `${i === selectedWalletIndex ? "→ " : "  "}N/A 0.00       0.00     0.00`;
    }
  });
  const walletData = await Promise.all(walletDataPromises);
  addLog("Wallet Data Updated .", "info");
  return walletData;
}

async function getNextNonce(provider, walletAddress) {
  try {
    const pendingNonce = await provider.getTransactionCount(walletAddress, "pending");
    const lastUsedNonce = nonceTracker[walletAddress] || pendingNonce - 1;
    const nextNonce = Math.max(pendingNonce, lastUsedNonce + 1);
    nonceTracker[walletAddress] = nextNonce;
    return nextNonce;
  } catch (error) {
    addLog(`Error fetching nonce for ${getShortAddress(walletAddress)}: ${error.message}`, "error");
    throw error;
  }
}

async function reportTransactionToApi(walletAddress, txHash, fromToken, toToken, fromAmount, accountIndex, proxyUrl, swapCount) {
  const payload = {
    address: walletAddress,
    amount: fromAmount,
    tokenFrom: fromToken,
    tokenTo: toToken,
    txHash: txHash
  };

  try {
    await makeApiRequest("post", API_URL, payload, proxyUrl);
    addLog(`Account ${accountIndex + 1} - Swap ${swapCount}: Transaction Reported Successfully`, "success");
  } catch (error) {
    addLog(`Account ${accountIndex + 1} - Swap ${swapCount}: Failed to report transaction - ${error.message}`, "error");
  }
}

async function checkAndApproveToken(wallet, provider, tokenAddress, amount, tokenName, accountIndex, swapCount) {
  if (shouldStop) {
    addLog("Approval stopped due to stop request.", "info");
    return false;
  }
  try {
    const signer = new ethers.Wallet(wallet, provider);
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
    const balance = await token.balanceOf(signer.address);
    const formattedBalance = tokenAddress === USDC_ADDRESS ? ethers.formatUnits(balance, 6) : ethers.formatEther(balance);
    if (balance < amount) {
      addLog(`Account ${accountIndex + 1}: Insufficient ${tokenName} balance (${formattedBalance})`, "error");
      return false;
    }
    const allowance = await token.allowance(signer.address, ROUTER_ADDRESS);
    if (allowance < amount) {
      addLog(`Account ${accountIndex + 1} - Swap ${swapCount}: Approving ${tokenName}...`, "info");
      const nonce = await getNextNonce(provider, signer.address);
      const tx = await token.approve(ROUTER_ADDRESS, ethers.MaxUint256, {
        gasLimit: 300000,
        maxFeePerGas: ethers.parseUnits("1", "gwei"),
        maxPriorityFeePerGas: ethers.parseUnits("0.5", "gwei"),
        nonce: nonce
      });
      addLog(`Account ${accountIndex + 1} - Swap ${swapCount}: Approval sent. Hash: ${getShortHash(tx.hash)}`, "success");
      await tx.wait();
    }
    return true;
  } catch (error) {
    addLog(`Account ${accountIndex + 1} - Swap ${swapCount}: Error approving ${tokenName}: ${error.message}`, "error");
    return false;
  }
}

async function executeSwap(wallet, provider, swapCount, fromToken, toToken, swapData, amount, direction, accountIndex, proxyUrl) {
  if (shouldStop) {
    addLog("Swap stopped due to stop request.", "info");
    return false;
  }
  try {
    const signer = new ethers.Wallet(wallet, provider);
    addLog(`Account ${accountIndex + 1} - Swap ${swapCount}: Executing Swap ${direction}...`, "info");
    const nonce = await getNextNonce(provider, signer.address);
    const tx = await signer.sendTransaction({
      to: ROUTER_ADDRESS,
      data: swapData,
      gasLimit: 300000,
      maxFeePerGas: ethers.parseUnits("5", "gwei"),
      maxPriorityFeePerGas: ethers.parseUnits("1", "gwei"),
      nonce: nonce
    });
    addLog(`Account ${accountIndex + 1} - Swap ${swapCount}: Transaction sent. Hash: ${getShortHash(tx.hash)}`, "success");
    const receipt = await tx.wait();
    addLog(`Account ${accountIndex + 1} - Swap ${swapCount}: Swapping ${direction} Completed`, "success");

    const fromAmountStr = fromToken === PRIOR_ADDRESS ? "0.1" : "0.2";
    const toAmountStr = fromToken === PRIOR_ADDRESS ? "0.20" : "0.100";
    const fromTokenName = fromToken === PRIOR_ADDRESS ? "PRIOR" : "USDC";
    const toTokenName = toToken === PRIOR_ADDRESS ? "PRIOR" : "USDC";

    await reportTransactionToApi(
      signer.address,
      tx.hash,
      fromTokenName,
      toTokenName,
      fromAmountStr,
      accountIndex,
      proxyUrl,
      swapCount
    );

    return true;
  } catch (error) {
    addLog(`Account ${accountIndex + 1} - ${swapCount}: Error Swapping ${direction}: ${error.message}`, "error");
    return false;
  }
}

// 以下是UI界面代码，保持不变...
const screen = blessed.screen({
  smartCSR: true,
  title: "Prior V2---修改X:crypto苦行僧",
  autoPadding: true,
  fullUnicode: true,
  dockBorders: false,  // 禁用默认边框
  ignoreDockContrast: true,
  terminal: 'xterm-256color',
  debug: false
});

const headerBox = blessed.box({
  top: 0,
  left: "center",
  width: "100%",
  height: 3,
  tags: true,
  style: { 
    fg: "cyan",
    bg: "default",
    bold: true
  }
});

figlet.text("X:@caitoudu", {
  font: "ANSI Shadow",
  horizontalLayout: "default"
}, (err, data) => {
  headerBox.setContent(
    err ? "{center}{bold}{cyan-fg}PRIOR SWAPPER{/cyan-fg}{/bold}{/center}" 
        : `{center}{cyan-fg}${data}{/cyan-fg}{/center}`
  );
  safeRender();
});

const statusBox = blessed.box({
  top: 3,
  left: 0,
  width: "100%",
  height: 3,
  tags: true,
  border: { 
    type: "line", 
    fg: "cyan" 
  },
  style: { 
    fg: "white", 
    bg: "default",
    border: { fg: "cyan" } 
  },
  content: "Status: Initializing...",
  padding: { left: 1, right: 1 }
});

const walletBox = blessed.list({
  top: 6,
  left: 0,
  width: "50%",
  height: "70%-5",
  label: " {cyan-fg}Wallet Information{/cyan-fg} ",
  border: { 
    type: "line", 
    fg: "cyan" 
  },
  style: { 
    border: { fg: "cyan" },
    fg: "white",
    selected: { bg: "magenta", fg: "black" }
  },
  scrollable: true,
  scrollbar: { 
    ch: " ",
    style: { bg: "cyan" }
  },
  padding: { left: 1, right: 1 }
});

// 日志框保持不变...
const logBox = blessed.log({
  top: 6,
  left: "50%",
  width: "50%",
  height: "70%-5",
  label: " {cyan-fg}Transaction Logs{/cyan-fg} ",
  border: { 
    type: "line", 
    fg: "cyan" 
  },
  style: { 
    border: { fg: "cyan" },
    fg: "white"
  },
  scrollable: true,
  scrollbar: { 
    ch: " ",
    style: { bg: "cyan" }
  },
  padding: { left: 1, right: 1 }
});

const menuBox = blessed.list({
  top: "70%",
  left: 0,
  width: "100%",
  height: "30%",
  label: " {cyan-fg}Menu{/cyan-fg} ",
  border: { 
    type: "line", 
    fg: "cyan" 
  },
  style: { 
    fg: "white",
    selected: { 
      bg: "magenta",
      fg: "black",
      bold: true
    },
    item: { 
      fg: "white",
      hover: { bg: "blue" }
    }
  },
  items: [
    " ◈  Stop Swap",
    " ◈  Claim Faucet",  // 修正拼写错误
    " ◈  Clear Logs",
    " ◈  Refresh",
    " ◈  Exit"
  ],
  keys: true,
  mouse: true,
  padding: { left: 2, top: 1 }
});

const separator = blessed.line({
  top: "70%-1",
  left: 0,
  width: "100%",
  orientation: "horizontal",
  type: "line",
  style: { fg: "cyan" }
});

screen.append(headerBox);
screen.append(statusBox);
screen.append(walletBox);
screen.append(logBox);
screen.append(menuBox);
screen.append(separator);

let isRendering = false;
function safeRender() {
  if (isRendering) return;
  isRendering = true;
  
  try {
    screen.render();
  } catch (e) {
    console.error("Render error:", e);
  } finally {
    setTimeout(() => isRendering = false, 50);
  }
}

function adjustLayout() {
  const height = screen.height;
  const width = screen.width;
  
  headerBox.width = width;
  statusBox.width = width;
  
  walletBox.width = Math.floor(width * 0.5);
  walletBox.height = Math.max(10, Math.floor(height * 0.7) - 6);
  
  logBox.left = Math.floor(width * 0.5);
  logBox.width = width - Math.floor(width * 0.5);
  logBox.height = walletBox.height;
  
  menuBox.top = walletBox.top + walletBox.height + 1;
  menuBox.height = height - menuBox.top - 1;
  menuBox.width = width;
  
  separator.top = menuBox.top - 1;
  
  safeRender();
}

function updateStatus() {
  const isProcessing = swapRunning || dailySwapInterval !== null;
  const status = swapRunning
    ? `${loadingSpinner[spinnerIndex]} ${chalk.yellowBright("Running")}`
    : chalk.green("Idle");
  const statusText = `Status: ${status} | Active Accounts: ${getShortAddress(walletInfo.address)} | Total Accounts: ${privateKeys.length} | Daily Swap Target: ${currentSwapIteration}/${loopCount} | PRIOR AUTO BOT`;
  statusBox.setContent(statusText);
  if (isProcessing) {
    if (blinkCounter % 1 === 0) { 
      statusBox.style.border.fg = borderBlinkColors[borderBlinkIndex];
      borderBlinkIndex = (borderBlinkIndex + 1) % borderBlinkColors.length;
    }
    blinkCounter++;
  } else {
    statusBox.style.border.fg = "cyan";
    borderBlinkIndex = 0;
    blinkCounter = 0;
  }

  spinnerIndex = (spinnerIndex + 1) % loadingSpinner.length;
  safeRender();
}

async function updateWallets() {
  const walletData = await updateWalletData();
  const header = `${chalk.bold.cyan("     Address".padEnd(12))}       ${chalk.bold.cyan("ETH".padEnd(8))}${chalk.bold.cyan("PRIOR".padEnd(8))}${chalk.bold.cyan("USDC".padEnd(8))}`;
  const separator = chalk.gray("-".repeat(49));
  walletBox.setItems([header, separator, ...walletData]);
  walletBox.select(0);
  safeRender();
}

function updateLogs() {
  logBox.setContent(transactionLogs.join("\n") || chalk.gray("Tidak ada log tersedia."));
  logBox.setScrollPerc(100);
  safeRender();
}

function updateMenu() {
  const isProcessing = swapRunning || dailySwapInterval !== null;
  menuBox.setItems(
    isProcessing
      ? ["Stop Swap", "Claim Faucet", "Clear Logs", "Refresh", "Exit"]
      : ["Start Auto Daily Swap", "Claim Faucet", "Clear Logs", "Refresh", "Exit"]
  );
  safeRender();
}

const statusInterval = setInterval(updateStatus, 150);

async function reportFaucetClaim(walletAddress, txHash, amount, blockNumber, accountIndex, proxyUrl) {
  try {
    const claimPayload = {
      address: walletAddress
    };
    
    await makeApiRequest("post", FAUCET_API_URL, claimPayload, proxyUrl);
    addLog(`Account ${accountIndex + 1}: Claim Faucet Reported Successfully`, "success");
  } catch (error) {
    addLog(`Account ${accountIndex + 1}: Failed to report faucet claim - ${error.message}`, "error");
  }
}

async function claimFaucetForAllAccounts() {
  if (privateKeys.length === 0) {
    addLog("No valid private keys found.", "error");
    return false;
  }
  
  let allSuccess = true;
  
  for (let accountIndex = 0; accountIndex < privateKeys.length && !shouldStop; accountIndex++) {
    const proxyUrl = proxies[accountIndex % proxies.length] || null;
    const provider = getProviderWithProxy(proxyUrl);
    const wallet = new ethers.Wallet(privateKeys[accountIndex], provider);
    const faucetContract = new ethers.Contract(FAUCET_ADDRESS, FAUCET_ABI, wallet);
    
    try {
      selectedWalletIndex = accountIndex;
      addLog(`Account ${accountIndex + 1}: Using Proxy ${proxyUrl || "none"}...`, "info");
      addLog(`Account ${accountIndex + 1}: Claiming Faucet Prior...`, "info");
      
      const lastClaim = await faucetContract.lastClaimTime(wallet.address);
      const interval = await faucetContract.claimInterval();
      const currentTime = Math.floor(Date.now() / 1000);
      const nextClaimTime = Number(lastClaim) + Number(interval);
      
      if (currentTime < nextClaimTime) {
        const waitTimeSeconds = nextClaimTime - currentTime;
        const hours = Math.floor(waitTimeSeconds / 3600);
        const minutes = Math.floor((waitTimeSeconds % 3600) / 60);
        addLog(`Account ${accountIndex + 1}: Must Wait ${hours} hours and ${minutes} minutes before claiming.`, "error");
        allSuccess = false;
        continue;
      }
      
      const nonce = await getNextNonce(provider, wallet.address);
      const tx = await faucetContract.claim({
        gasLimit: 300000,
        maxFeePerGas: ethers.parseUnits("1", "gwei"),
        maxPriorityFeePerGas: ethers.parseUnits("0.5", "gwei"),
        nonce: nonce
      });
      
      addLog(`Account ${accountIndex + 1}: Claim sent. Hash: ${getShortHash(tx.hash)}`, "success");
      const receipt = await tx.wait();
      addLog(`Account ${accountIndex + 1}: Faucet Claimed Successfully`, "success");
      
      const txHash = tx.hash;
      const blockNumber = receipt.blockNumber;
      const amount = "1";
      
      await reportFaucetClaim(wallet.address, txHash, amount, blockNumber, accountIndex, proxyUrl);
      await updateWallets();
      
      // 等待10秒再进行下一个账号
      if (accountIndex < privateKeys.length - 1 && !shouldStop) {
        addLog(`Waiting 10 seconds before next account...`, "wait");
        await sleep(10000);
      }
    } catch (error) {
      addLog(`Account ${accountIndex + 1}: Error Claiming Faucet: ${error.message}`, "error");
      allSuccess = false;
    }
  }
  
  return allSuccess;
}

async function performSwapsForAllAccounts() {
  if (privateKeys.length === 0) {
    addLog("No valid private keys found.", "error");
    return false;
  }
  
  let allSuccess = true;
  loopCount = 5; // 设置每个账号执行5次swap
  
  for (let accountIndex = 0; accountIndex < privateKeys.length && !shouldStop; accountIndex++) {
    selectedWalletIndex = accountIndex;
    const proxyUrl = proxies[accountIndex % proxies.length] || null;
    const provider = getProviderWithProxy(proxyUrl);
    
    addLog(`Account ${accountIndex + 1}: Starting 5 swaps...`, "info");
    
    let swapCount = 1;
    let isPriorToUsdc = true;
    
    while (swapCount <= loopCount && !shouldStop) {
      currentSwapIteration = swapCount;
      updateStatus();
      
      const direction = isPriorToUsdc ? "PRIOR -> USDC" : "USDC -> PRIOR";
      const fromToken = isPriorToUsdc ? PRIOR_ADDRESS : USDC_ADDRESS;
      const toToken = isPriorToUsdc ? USDC_ADDRESS : PRIOR_ADDRESS;
      const swapData = isPriorToUsdc ? SWAP_PRIOR_TO_USDC_DATA : SWAP_USDC_TO_PRIOR_DATA;
      const amount = isPriorToUsdc ? ethers.parseEther("0.1") : ethers.parseUnits("0.2", 6);
      const tokenName = isPriorToUsdc ? "PRIOR" : "USDC";
      
      const isApproved = await checkAndApproveToken(
        privateKeys[accountIndex], 
        provider, 
        fromToken, 
        amount, 
        tokenName, 
        accountIndex,
        swapCount
      );
      
      if (!isApproved || shouldStop) {
        swapCount++;
        isPriorToUsdc = !isPriorToUsdc;
        continue;
      }
      
      const swapSuccess = await executeSwap(
        privateKeys[accountIndex], 
        provider, 
        swapCount, 
        fromToken, 
        toToken, 
        swapData, 
        amount, 
        direction, 
        accountIndex, 
        proxyUrl
      );
      
      if (!swapSuccess) {
        allSuccess = false;
      }
      
      swapCount++;
      isPriorToUsdc = !isPriorToUsdc;
      
      // 在每次swap之间等待15-30秒
      if (swapCount <= loopCount && !shouldStop) {
        const randomDelay = Math.floor(Math.random() * (30000 - 15000 + 1)) + 15000;
        addLog(`Account ${accountIndex + 1}: Waiting ${Math.floor(randomDelay / 1000)} seconds before next swap...`, "wait");
        await sleep(randomDelay);
      }
    }
    
    // 在账号之间等待30秒
    if (accountIndex < privateKeys.length - 1 && !shouldStop) {
      addLog(`Waiting 30 seconds before next account...`, "wait");
      await sleep(30000);
    }
  }
  
  return allSuccess;
}

async function runDailySwapCycle() {
  if (swapRunning) {
    addLog("Previous cycle still running.", "error");
    return;
  }
  
  addLog("Starting daily cycle: Claim Faucet for all accounts first...", "info");
  swapRunning = true;
  shouldStop = false;
  hasLoggedSleepInterrupt = false;
  currentCycle++;
  currentSwapIteration = 0;
  walletInfo.cycleCount = currentCycle;
  walletInfo.nextCycle = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  
  updateMenu();
  updateStatus();
  
  try {
    // 第一步：为所有账号Claim Faucet
    const faucetSuccess = await claimFaucetForAllAccounts();
    
    if (!faucetSuccess && !shouldStop) {
      addLog("Some faucet claims failed, but continuing with swaps...", "error");
    }
    
    // 第二步：为所有账号执行5次swap
    if (!shouldStop) {
      addLog("Starting swap process for all accounts...", "info");
      const swapSuccess = await performSwapsForAllAccounts();
      
      if (!swapSuccess) {
        addLog("Some swaps failed during the daily cycle.", "error");
      }
    }
    
    if (!shouldStop) {
      addLog("Daily cycle completed successfully. Waiting 24 hours for next cycle...", "success");
      dailySwapInterval = setTimeout(runDailySwapCycle, 24 * 60 * 60 * 1000);
    }
  } catch (error) {
    addLog(`Daily cycle failed: ${error.message}`, "error");
  } finally {
    swapRunning = false;
    shouldStop = false;
    hasLoggedSleepInterrupt = false;
    currentSwapIteration = 0;
    updateMenu();
    updateStatus();
  }
}

async function runDailySwap() {
  if (privateKeys.length === 0) {
    addLog("No valid private keys found.", "error");
    return;
  }

  addLog(`Starting daily cycle for ${privateKeys.length} accounts.`, "info");
  await runDailySwapCycle();
}

// 以下是事件监听代码，保持不变...
menuBox.on("select", async item => {
  const action = item.getText();
  switch (action) {
    case "Start Auto Daily Swap":
      await runDailySwap();
      break;
    case "Stop Swap":
      shouldStop = true;
      swapRunning = false;
      if (dailySwapInterval) {
        clearTimeout(dailySwapInterval);
        dailySwapInterval = null;
        addLog("Daily swap stopped.", "success");
      }
      addLog("Swap transactions stopped.", "success");
      updateMenu();
      updateStatus();
      break;
    case "Claim Faucet":
      await claimFaucetForAllAccounts();
      break;
    case "Clear Logs":
      clearTransactionLogs();
      break;
    case "Refresh":
      await updateWallets();
      addLog("Data refreshed.", "success");
      break;
    case "Exit":
      clearInterval(statusInterval);
      process.exit(0);
  }
  menuBox.focus();
  safeRender();
});

screen.key(["escape", "q", "C-c"], () => {
  clearInterval(statusInterval);
  process.exit(0);
});
screen.key(["C-up"], () => { logBox.scroll(-1); safeRender(); });
screen.key(["C-down"], () => { logBox.scroll(1); safeRender(); });

screen.on("resize", adjustLayout);
adjustLayout();

loadPrivateKeys();
loadProxies();
updateStatus();
updateWallets();
updateLogs();
updateMenu();

menuBox.focus();
screen.render();

// 快捷键绑定保持不变...
screen.key(["escape", "q", "C-c"], () => process.exit(0));
screen.key(["C-up"], () => { logBox.scroll(-1); safeRender(); });
screen.key(["C-down"], () => { logBox.scroll(1); safeRender(); });