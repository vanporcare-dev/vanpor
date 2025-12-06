import express from 'express';
import cors from 'cors';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = "rahasia-super-aman-123"; // Ganti dengan env variable nanti

app.use(cors());
app.use(express.json());

// --- MIDDLEWARE AUTH ---
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.sendStatus(401);

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
};

// --- API ROUTES ---

// 1. REGISTER
app.post('/api/auth/register', async (req, res) => {
    const { name, username, password, phoneNumber } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const user = await prisma.user.create({
            data: { name, username, password: hashedPassword, phoneNumber, balance: 0 }
        });
        res.json({ message: "Registrasi Berhasil", userId: user.id });
    } catch (error) {
        res.status(400).json({ error: "Username sudah digunakan" });
    }
});

// 2. LOGIN
app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    const user = await prisma.user.findUnique({ where: { username } });

    if (!user) return res.status(404).json({ error: "User tidak ditemukan" });
    if (user.isBlocked) return res.status(403).json({ error: "Akun diblokir" });

    const validPass = await bcrypt.compare(password, user.password);
    if (!validPass) return res.status(400).json({ error: "Password salah" });

    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET);
    const { password: _, ...userData } = user;
    res.json({ token, user: userData });
});

// 3. GET USER PROFILE (Realtime Balance)
app.get('/api/user/me', authenticateToken, async (req, res) => {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return res.status(404).json({ error: "User tidak ditemukan" });
    const { password: _, ...userData } = user;
    res.json(userData);
});

// 4. TRANSFER SALDO (Fitur Utama yang Anda Minta)
app.post('/api/transaction/transfer', authenticateToken, async (req, res) => {
    const { targetUsername, amount, note } = req.body;
    const senderId = req.user.id;
    const transferAmount = parseInt(amount);

    if (transferAmount < 10000) return res.status(400).json({ error: "Minimal transfer Rp 10.000" });

    try {
        // TRANSAKSI ATOMIC: Semua berhasil atau semua gagal. Tidak ada saldo hilang.
        const result = await prisma.$transaction(async (tx) => {
            // A. Ambil Sender Terbaru
            const sender = await tx.user.findUnique({ where: { id: senderId } });
            if (sender.balance < transferAmount) throw new Error("Saldo tidak mencukupi");

            // B. Ambil Receiver
            const receiver = await tx.user.findUnique({ where: { username: targetUsername } });
            if (!receiver) throw new Error("Username penerima tidak ditemukan");
            if (receiver.id === senderId) throw new Error("Tidak bisa transfer ke diri sendiri");

            // C. Potong Saldo Pengirim
            await tx.user.update({
                where: { id: senderId },
                data: { balance: { decrement: transferAmount } }
            });

            // D. Tambah Saldo Penerima
            await tx.user.update({
                where: { id: receiver.id },
                data: { balance: { increment: transferAmount } }
            });

            // E. Catat Riwayat
            await tx.transaction.create({
                data: {
                    senderId,
                    receiverId: receiver.id,
                    productName: "Transfer Saldo",
                    customerNumber: receiver.username,
                    amount: transferAmount,
                    type: "TRANSFER",
                    status: "SUCCESS",
                    note: note || "-"
                }
            });

            return { newBalance: sender.balance - transferAmount };
        });

        res.json({ message: "Transfer Berhasil", balance: result.newBalance });

    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// 5. GET HISTORY
app.get('/api/transactions', authenticateToken, async (req, res) => {
    const transactions = await prisma.transaction.findMany({
        where: {
            OR: [
                { senderId: req.user.id },
                { receiverId: req.user.id },
                { userId: req.user.id } // Untuk transaksi pembelian biasa
            ]
        },
        orderBy: { createdAt: 'desc' },
        include: { sender: true, receiver: true } // Sertakan info nama pengirim/penerima
    });
    res.json(transactions);
});

// Jalankan Server
app.listen(PORT, () => {
    console.log(`🔥 Server Backend berjalan di http://localhost:${PORT}`);
});