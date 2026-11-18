const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, ScanCommand, DeleteCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const s3Client = new S3Client({ region: 'us-east-1' });
const ddbClient = new DynamoDBClient({ region: 'us-east-1' });
const docClient = DynamoDBDocumentClient.from(ddbClient);

const BUCKET_NAME = 's3-project-green.ops';
const TABLE_NAME = 'PhotoJournal';

const upload = multer({ storage: multer.memoryStorage() });

// 1. CREATE: Upload photo to S3 and save metadata in DynamoDB
app.post('/api/photos', upload.single('image'), async (req, res) => {
  try {
    const { title, mood, description } = req.body;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: 'No image file provided' });
    }

    const photo_id = Date.now().toString();
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const fileName = `${photo_id}-${safeName}`;

    await s3Client.send(new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: fileName,
      Body: file.buffer,
      ContentType: file.mimetype,
    }));

    const imageUrl = `https://${BUCKET_NAME}.s3.amazonaws.com/${fileName}`;
    const timestamp = new Date().toISOString();

    const item = {
      photo_id,
      title: title || 'Untitled moment',
      mood: mood || 'Happy',
      description: description || '',
      imageUrl,
      fileName,
      timestamp,
    };

    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: item,
    }));

    res.status(201).json({ message: 'Memory saved', item });
  } catch (error) {
    console.error('Error uploading photo:', error);
    res.status(500).json({ error: error.message });
  }
});

// 2. READ: Get all memories with S3 pre-signed URLs so private bucket images load
app.get('/api/photos', async (req, res) => {
  try {
    const data = await docClient.send(new ScanCommand({ TableName: TABLE_NAME }));
    const sorted = (data.Items || []).sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));

    const itemsWithSignedUrls = await Promise.all(sorted.map(async (item) => {
      const key = item.fileName || item.s3_image_key;
      if (key) {
        try {
          const signedUrl = await getSignedUrl(
            s3Client,
            new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key }),
            { expiresIn: 3600 }
          );
          return { ...item, imageUrl: signedUrl, fileName: key };
        } catch {
          return item;
        }
      }
      return item;
    }));

    res.json(itemsWithSignedUrls);
  } catch (error) {
    console.error('Error fetching photos:', error);
    res.status(500).json({ error: error.message });
  }
});

// 3. UPDATE: Edit title and mood of a memory in DynamoDB
app.put('/api/photos/:photo_id', async (req, res) => {
  try {
    const { photo_id } = req.params;
    const { title, mood } = req.body;

    const result = await docClient.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { photo_id },
      UpdateExpression: 'SET #t = :t, #m = :m',
      ExpressionAttributeNames: {
        '#t': 'title',
        '#m': 'mood',
      },
      ExpressionAttributeValues: {
        ':t': title || 'Untitled moment',
        ':m': mood || 'Happy',
      },
      ReturnValues: 'ALL_NEW',
    }));

    res.json({ message: 'Memory updated', item: result.Attributes });
  } catch (error) {
    console.error('Error updating photo:', error);
    res.status(500).json({ error: error.message });
  }
});

// 4. DELETE: Remove photo from S3 (if key exists) and delete item from DynamoDB
app.delete('/api/photos/:photo_id', async (req, res) => {
  try {
    const { photo_id } = req.params;
    const { fileName } = req.query;

    if (fileName && fileName !== 'undefined' && fileName !== 'null') {
      try {
        await s3Client.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: fileName }));
      } catch (s3Err) {
        console.warn('S3 object delete skipped:', s3Err.message);
      }
    }

    await docClient.send(new DeleteCommand({ TableName: TABLE_NAME, Key: { photo_id } }));
    res.json({ message: 'Memory deleted' });
  } catch (error) {
    console.error('Error deleting photo:', error);
    res.status(500).json({ error: error.message });
  }
});

// Health telemetry endpoint for observability and automated rollback checks
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "healthy",
    service: "keepsake-photo-journal",
    uptimeSeconds: Math.floor(process.uptime()),
    memoryUsageMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    timestamp: new Date().toISOString()
  });
});

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Keepsake Photo Journal running on port ${port}`);
  });
}

module.exports = app;
