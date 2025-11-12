const express = require('express');
const multer = require('multer');
const { supabaseAdmin } = require('../config/supabase');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');

const router = express.Router();

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    // Accept images and videos
    if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image and video files are allowed'));
    }
  }
});

// Get all incidents (Admin and Superuser see all, Users see only their own)
router.get('/', authenticateToken, async (req, res) => {
  try {
    let query = supabaseAdmin
      .from('incidents')
      .select(`
        *,
        user:users!incidents_user_id_fkey(id, username, department),
        incident_responses(*)
      `)
      .order('created_at', { ascending: false });

    // Regular users only see their own incidents
    if (req.user.role === 'user') {
      query = query.eq('user_id', req.user.id);
    }

    const { data: incidents, error } = await query;

    if (error) throw error;

    res.json(incidents);
  } catch (error) {
    console.error('Error fetching incidents:', error);
    res.status(500).json({ error: 'Failed to fetch incidents' });
  }
});

// Get single incident with attachments
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { data: incident, error } = await supabaseAdmin
      .from('incidents')
      .select(`
        *,
        user:users!incidents_user_id_fkey(id, username, department),
        incident_attachments(*),
        incident_responses(*)
      `)
      .eq('id', req.params.id)
      .single();

    if (error) throw error;

    // Check access rights
    if (req.user.role === 'user' && incident.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Get signed URLs for attachments
    if (incident.incident_attachments && incident.incident_attachments.length > 0) {
      for (let attachment of incident.incident_attachments) {
        const fileName = attachment.file_url.split('/').pop();
        const { data: signedUrlData } = await supabaseAdmin
          .storage
          .from('incident-attachments')
          .createSignedUrl(fileName, 3600); // 1 hour expiry

        if (signedUrlData) {
          attachment.signed_url = signedUrlData.signedUrl;
        }
      }
    }

    res.json(incident);
  } catch (error) {
    console.error('Error fetching incident:', error);
    res.status(500).json({ error: 'Failed to fetch incident' });
  }
});

// Create incident (Users only)
router.post('/', authenticateToken, authorizeRoles('user'), upload.array('attachments', 10), async (req, res) => {
  const {
    subject,
    date_of_incident,
    project_name,
    source_of_incident,
    mistake_committed,
    preliminary_investigation,
    details_and_findings,
    suggestions
  } = req.body;

  // Validate required fields
  if (!subject || !date_of_incident || !source_of_incident || !mistake_committed || !details_and_findings) {
    return res.status(400).json({ error: 'Required fields are missing' });
  }

  try {
    // Create incident
    const { data: incident, error: incidentError } = await supabaseAdmin
      .from('incidents')
      .insert({
        user_id: req.user.id,
        subject,
        date_of_incident,
        project_name,
        source_of_incident,
        mistake_committed,
        preliminary_investigation: preliminary_investigation === 'true' || preliminary_investigation === true,
        details_and_findings,
        suggestions,
        status: 'open'
      })
      .select()
      .single();

    if (incidentError) throw incidentError;

    // Upload attachments if any
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const fileName = `${incident.id}/${Date.now()}-${file.originalname}`;
        
        // Upload to Supabase Storage
        const { data: uploadData, error: uploadError } = await supabaseAdmin
          .storage
          .from('incident-attachments')
          .upload(fileName, file.buffer, {
            contentType: file.mimetype,
            upsert: false
          });

        if (uploadError) {
          console.error('Error uploading file:', uploadError);
          continue;
        }

        // Save attachment record
        await supabaseAdmin
          .from('incident_attachments')
          .insert({
            incident_id: incident.id,
            file_url: uploadData.path,
            file_type: file.mimetype
          });
      }
    }

    res.status(201).json({
      message: 'Incident reported successfully',
      incident
    });
  } catch (error) {
    console.error('Error creating incident:', error);
    res.status(500).json({ error: 'Failed to create incident' });
  }
});

// Acknowledge incident (Superuser only)
router.post('/:id/acknowledge', authenticateToken, authorizeRoles('superuser', 'admin'), async (req, res) => {
  const {
    investigation_findings,
    root_cause,
    action_taken,
    further_action_plan,
    status
  } = req.body;

  const incidentId = req.params.id;

  // Validate status
  if (status && !['open', 'in-progress', 'closed'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  try {
    // Create response record
    const { data: response, error: responseError } = await supabaseAdmin
      .from('incident_responses')
      .insert({
        incident_id: incidentId,
        investigation_findings,
        root_cause,
        action_taken,
        further_action_plan,
        acknowledged_by: req.user.id
      })
      .select()
      .single();

    if (responseError) throw responseError;

    // Update incident status
    if (status) {
      const { error: updateError } = await supabaseAdmin
        .from('incidents')
        .update({ 
          status,
          updated_at: new Date().toISOString()
        })
        .eq('id', incidentId);

      if (updateError) throw updateError;
    }

    res.json({
      message: 'Incident acknowledged successfully',
      response
    });
  } catch (error) {
    console.error('Error acknowledging incident:', error);
    res.status(500).json({ error: 'Failed to acknowledge incident' });
  }
});

// Update incident status (Superuser and Admin only)
router.patch('/:id/status', authenticateToken, authorizeRoles('superuser', 'admin'), async (req, res) => {
  const { status } = req.body;
  const incidentId = req.params.id;

  if (!['open', 'in-progress', 'closed'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  try {
    const { data: incident, error } = await supabaseAdmin
      .from('incidents')
      .update({ 
        status,
        updated_at: new Date().toISOString()
      })
      .eq('id', incidentId)
      .select()
      .single();

    if (error) throw error;

    res.json({
      message: 'Incident status updated successfully',
      incident
    });
  } catch (error) {
    console.error('Error updating incident status:', error);
    res.status(500).json({ error: 'Failed to update incident status' });
  }
});

// Delete incident (Admin only)
router.delete('/:id', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  const incidentId = req.params.id;

  try {
    // Get attachments to delete from storage
    const { data: attachments } = await supabaseAdmin
      .from('incident_attachments')
      .select('file_url')
      .eq('incident_id', incidentId);

    // Delete files from storage
    if (attachments && attachments.length > 0) {
      const filePaths = attachments.map(att => att.file_url);
      await supabaseAdmin
        .storage
        .from('incident-attachments')
        .remove(filePaths);
    }

    // Delete incident (cascades to attachments and responses)
    const { error } = await supabaseAdmin
      .from('incidents')
      .delete()
      .eq('id', incidentId);

    if (error) throw error;

    res.json({ message: 'Incident deleted successfully' });
  } catch (error) {
    console.error('Error deleting incident:', error);
    res.status(500).json({ error: 'Failed to delete incident' });
  }
});

module.exports = router;