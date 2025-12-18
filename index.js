const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const multer = require("multer");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

/* ---------------- DATABASE ---------------- */
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch(err => console.error(err));

/* ---------------- MODELS ---------------- */
const UserSchema = new mongoose.Schema({
  username: { type: String, unique: true },
  email: { type: String, unique: true },
  password: String
}, { timestamps: true });

const PostSchema = new mongoose.Schema({
  content: String,
  image: String, // ImgBB URL
  author: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  likes: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }]
}, { timestamps: true });

const CommentSchema = new mongoose.Schema({
  text: String,
  post: { type: mongoose.Schema.Types.ObjectId, ref: "Post" },
  author: { type: mongoose.Schema.Types.ObjectId, ref: "User" }
}, { timestamps: true });

const User = mongoose.model("User", UserSchema);
const Post = mongoose.model("Post", PostSchema);
const Comment = mongoose.model("Comment", CommentSchema);

/* ---------------- AUTH MIDDLEWARE ---------------- */
const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json("No token");

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.id;
    next();
  } catch {
    res.status(401).json("Invalid token");
  }
};

/* ---------------- MULTER (MEMORY) ---------------- */
const upload = multer({ storage: multer.memoryStorage() });

/* ---------------- AUTH ROUTES ---------------- */
app.post("/api/register", async (req, res) => {
  const hash = await bcrypt.hash(req.body.password, 10);
  await new User({ ...req.body, password: hash }).save();
  res.json("User registered");
});

app.post("/api/login", async (req, res) => {
  const user = await User.findOne({ email: req.body.email });
  if (!user) return res.status(400).json("Invalid credentials");

  const valid = await bcrypt.compare(req.body.password, user.password);
  if (!valid) return res.status(400).json("Invalid credentials");

  const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET);
  res.json({ token, user });
});

/* ---------------- PROFILE ---------------- */
app.get("/api/me", auth, async (req, res) => {
  const user = await User.findById(req.userId).select("-password");
  const posts = await Post.find({ author: req.userId });
  res.json({ user, posts });
});

/* ---------------- CREATE POST (ImgBB) ---------------- */
app.post("/api/posts", auth, upload.single("image"), async (req, res) => {
  let imageUrl = null;

  if (req.file) {
    const base64 = req.file.buffer.toString("base64");

    const response = await axios.post(
      "https://api.imgbb.com/1/upload",
      null,
      {
        params: {
          key: process.env.IMGBB_API_KEY,
          image: base64
        }
      }
    );

    imageUrl = response.data.data.url;
  }

  const post = new Post({
    content: req.body.content,
    image: imageUrl,
    author: req.userId
  });

  await post.save();
  res.json(post);
});

/* ---------------- GET FEED ---------------- */
app.get("/api/posts", async (req, res) => {
  const posts = await Post.find()
    .populate("author", "username")
    .sort({ createdAt: -1 });

  const result = await Promise.all(
    posts.map(async post => {
      const comments = await Comment.find({ post: post._id })
        .populate("author", "username");
      return { ...post.toObject(), comments };
    })
  );

  res.json(result);
});

/* ---------------- EDIT POST ---------------- */
app.put("/api/posts/:id", auth, async (req, res) => {
  const post = await Post.findById(req.params.id);
  if (post.author.toString() !== req.userId)
    return res.status(403).json("Not allowed");

  post.content = req.body.content || post.content;
  await post.save();
  res.json(post);
});

/* ---------------- DELETE POST ---------------- */
app.delete("/api/posts/:id", auth, async (req, res) => {
  const post = await Post.findById(req.params.id);
  if (post.author.toString() !== req.userId)
    return res.status(403).json("Not allowed");

  await post.deleteOne();
  await Comment.deleteMany({ post: post._id });
  res.json("Post deleted");
});

/* ---------------- LIKE POST ---------------- */
app.put("/api/posts/:id/like", auth, async (req, res) => {
  const post = await Post.findById(req.params.id);
  if (!post.likes.includes(req.userId)) {
    post.likes.push(req.userId);
    await post.save();
  }
  res.json(post);
});

/* ---------------- COMMENTS ---------------- */
app.post("/api/posts/:id/comments", auth, async (req, res) => {
  const comment = new Comment({
    text: req.body.text,
    post: req.params.id,
    author: req.userId
  });
  await comment.save();
  res.json(comment);
});

app.delete("/api/comments/:id", auth, async (req, res) => {
  const comment = await Comment.findById(req.params.id);
  if (comment.author.toString() !== req.userId)
    return res.status(403).json("Not allowed");

  await comment.deleteOne();
  res.json("Comment deleted");
});

/* ---------------- SERVER ---------------- */
app.listen(process.env.PORT, () => {
  console.log("Server running on port " + process.env.PORT);
});
