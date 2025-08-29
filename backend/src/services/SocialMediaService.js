const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const cron = require('node-cron');

class SocialMediaService {
  constructor() {
    this.supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY
    );
    
    // Start scheduled post processor
    this.startScheduledPostProcessor();
  }

  // Connect social media account
  async connectAccount(userId, platform, accessToken, refreshToken, platformUserId) {
    try {
      const { data, error } = await this.supabase
        .from('social_media_accounts')
        .upsert({
          user_id: userId,
          platform,
          access_token: accessToken,
          refresh_token: refreshToken,
          platform_user_id: platformUserId,
          connected_at: new Date().toISOString(),
          status: 'active'
        })
        .select()
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      console.error('Error connecting account:', error);
      throw error;
    }
  }

  // Get user's social media accounts
  async getUserAccounts(userId) {
    try {
      const { data, error } = await this.supabase
        .from('social_media_accounts')
        .select('*')
        .eq('user_id', userId)
        .eq('status', 'active');

      if (error) throw error;
      return data || [];
    } catch (error) {
      console.error('Error fetching user accounts:', error);
      throw error;
    }
  }

  // Post article to social media platforms
  async postArticle(userId, platforms, content, media = [], scheduledTime = null) {
    try {
      if (scheduledTime) {
        return await this.schedulePost(userId, platforms, content, media, scheduledTime);
      }

      const results = [];
      
      for (const platform of platforms) {
        try {
          const result = await this.postToPlatform(platform, content, media);
          results.push({
            platform,
            success: true,
            postId: result.id,
            url: result.url
          });
        } catch (error) {
          console.error(`Error posting to ${platform}:`, error);
          results.push({
            platform,
            success: false,
            error: error.message
          });
        }
      }

      // Store post in database
      await this.storePost(userId, platforms, content, media, results);

      return results;
    } catch (error) {
      console.error('Error posting article:', error);
      throw error;
    }
  }

  // Post to specific platform
  async postToPlatform(platform, content, media) {
    switch (platform) {
      case 'facebook':
        return await this.postToFacebook(content, media);
      case 'twitter':
        return await this.postToTwitter(content, media);
      case 'linkedin':
        return await this.postToLinkedIn(content, media);
      case 'instagram':
        return await this.postToInstagram(content, media);
      case 'pinterest':
        return await this.postToPinterest(content, media);
      case 'youtube':
        return await this.postToYouTube(content, media);
      case 'tiktok':
        return await this.postToTikTok(content, media);
      default:
        throw new Error(`Unsupported platform: ${platform}`);
    }
  }

  // Post to Facebook
  async postToFacebook(content, media) {
    try {
      // This is a simplified example - you'd need to implement actual Facebook posting logic
      const response = await axios.post(
        `https://graph.facebook.com/v18.0/me/feed`,
        {
          message: content,
          access_token: process.env.FACEBOOK_ACCESS_TOKEN
        }
      );

      return {
        id: response.data.id,
        url: `https://facebook.com/${response.data.id}`
      };
    } catch (error) {
      throw new Error(`Facebook posting failed: ${error.message}`);
    }
  }

  // Post to Twitter
  async postToTwitter(content, media) {
    try {
      // Simplified Twitter posting - implement actual API calls
      const response = await axios.post(
        'https://api.twitter.com/2/tweets',
        {
          text: content
        },
        {
          headers: {
            'Authorization': `Bearer ${process.env.TWITTER_ACCESS_TOKEN}`,
            'Content-Type': 'application/json'
          }
        }
      );

      return {
        id: response.data.data.id,
        url: `https://twitter.com/user/status/${response.data.data.id}`
      };
    } catch (error) {
      throw new Error(`Twitter posting failed: ${error.message}`);
    }
  }

  // Post to LinkedIn
  async postToLinkedIn(content, media) {
    try {
      // Simplified LinkedIn posting - implement actual API calls
      const response = await axios.post(
        'https://api.linkedin.com/v2/ugcPosts',
        {
          author: `urn:li:person:${process.env.LINKEDIN_PERSON_ID}`,
          lifecycleState: 'PUBLISHED',
          specificContent: {
            'com.linkedin.ugc.ShareContent': {
              shareCommentary: {
                text: content
              },
              shareMediaCategory: 'NONE'
            }
          },
          visibility: {
            'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC'
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${process.env.LINKEDIN_ACCESS_TOKEN}`,
            'Content-Type': 'application/json'
          }
        }
      );

      return {
        id: response.data.id,
        url: `https://linkedin.com/feed/update/${response.data.id}`
      };
    } catch (error) {
      throw new Error(`LinkedIn posting failed: ${error.message}`);
    }
  }

  // Post to Instagram
  async postToInstagram(content, media) {
    try {
      // Simplified Instagram posting - implement actual API calls
      const response = await axios.post(
        'https://graph.instagram.com/v12.0/me/media',
        {
          image_url: media[0] || '',
          caption: content,
          access_token: process.env.INSTAGRAM_ACCESS_TOKEN
        }
      );

      return {
        id: response.data.id,
        url: `https://instagram.com/p/${response.data.id}`
      };
    } catch (error) {
      throw new Error(`Instagram posting failed: ${error.message}`);
    }
  }

  // Post to Pinterest
  async postToPinterest(content, media) {
    try {
      // Simplified Pinterest posting - implement actual API calls
      const response = await axios.post(
        'https://api.pinterest.com/v5/pins',
        {
          board_id: process.env.PINTEREST_BOARD_ID,
          title: content.substring(0, 100),
          description: content,
          link: media[0] || '',
          media_source: {
            source_type: 'image_url',
            url: media[0] || ''
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${process.env.PINTEREST_ACCESS_TOKEN}`,
            'Content-Type': 'application/json'
          }
        }
      );

      return {
        id: response.data.id,
        url: `https://pinterest.com/pin/${response.data.id}`
      };
    } catch (error) {
      throw new Error(`Pinterest posting failed: ${error.message}`);
    }
  }

  // Post to YouTube using Google APIs
  async postToYouTube(content, media) {
    try {
      // YouTube posting requires video upload - this is simplified
      // You would use the googleapis package here for actual implementation
      const response = await axios.post(
        'https://www.googleapis.com/upload/youtube/v3/videos',
        {
          snippet: {
            title: content.substring(0, 100),
            description: content,
            tags: content.split(' ').slice(0, 10)
          },
          status: {
            privacyStatus: 'public'
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${process.env.YOUTUBE_ACCESS_TOKEN}`,
            'Content-Type': 'application/json'
          }
        }
      );

      return {
        id: response.data.id,
        url: `https://youtube.com/watch?v=${response.data.id}`
      };
    } catch (error) {
      throw new Error(`YouTube posting failed: ${error.message}`);
    }
  }

  // Post to TikTok (placeholder - implement with actual TikTok API)
  async postToTikTok(content, media) {
    try {
      // TikTok posting requires video upload - this is a placeholder
      // You would need to implement actual TikTok API integration
      throw new Error('TikTok posting not yet implemented');
    } catch (error) {
      throw new Error(`TikTok posting failed: ${error.message}`);
    }
  }

  // Store post in database
  async storePost(userId, platforms, content, media, results) {
    try {
      const { data, error } = await this.supabase
        .from('social_media_posts')
        .insert({
          user_id: userId,
          content,
          media: media,
          platforms: platforms,
          results: results,
          posted_at: new Date().toISOString()
        })
        .select()
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      console.error('Error storing post:', error);
      throw error;
    }
  }

  // Schedule post
  async schedulePost(userId, platforms, content, media, scheduledTime) {
    try {
      const { data, error } = await this.supabase
        .from('scheduled_posts')
        .insert({
          user_id: userId,
          content,
          media: media,
          platforms: platforms,
          scheduled_time: scheduledTime,
          status: 'scheduled'
        })
        .select()
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      console.error('Error scheduling post:', error);
      throw error;
    }
  }

  // Get scheduled posts
  async getScheduledPosts(userId) {
    try {
      const { data, error } = await this.supabase
        .from('scheduled_posts')
        .select('*')
        .eq('user_id', userId)
        .eq('status', 'scheduled')
        .order('scheduled_time', { ascending: true });

      if (error) throw error;
      return data || [];
    } catch (error) {
      console.error('Error fetching scheduled posts:', error);
      throw error;
    }
  }

  // Delete scheduled post
  async deleteScheduledPost(userId, postId) {
    try {
      const { error } = await this.supabase
        .from('scheduled_posts')
        .delete()
        .eq('id', postId)
        .eq('user_id', userId);

      if (error) throw error;
      return true;
    } catch (error) {
      console.error('Error deleting scheduled post:', error);
      throw error;
    }
  }

  // Get posts from social media
  async getPosts(userId, platform = null, limit = 20, offset = 0) {
    try {
      let query = this.supabase
        .from('social_media_posts')
        .select('*')
        .eq('user_id', userId)
        .order('posted_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (platform) {
        query = query.contains('platforms', [platform]);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data || [];
    } catch (error) {
      console.error('Error fetching posts:', error);
      throw error;
    }
  }

  // Get analytics from social media
  async getAnalytics(userId, platform = null, startDate = null, endDate = null) {
    try {
      // This is a simplified analytics implementation
      // In a real app, you'd fetch actual analytics from each platform's API
      const analytics = {
        totalPosts: 0,
        totalEngagement: 0,
        platformBreakdown: {},
        engagementTrend: []
      };

      // Fetch posts for analytics
      const posts = await this.getPosts(userId, platform, 1000, 0);
      
      analytics.totalPosts = posts.length;
      
      // Calculate engagement (simplified)
      posts.forEach(post => {
        post.platforms.forEach(p => {
          if (!analytics.platformBreakdown[p]) {
            analytics.platformBreakdown[p] = { posts: 0, engagement: 0 };
          }
          analytics.platformBreakdown[p].posts++;
          analytics.platformBreakdown[p].engagement += Math.floor(Math.random() * 100); // Mock data
        });
      });

      return analytics;
    } catch (error) {
      console.error('Error fetching analytics:', error);
      throw error;
    }
  }

  // Refresh social media tokens
  async refreshTokens(userId) {
    try {
      const accounts = await this.getUserAccounts(userId);
      const refreshedAccounts = [];

      for (const account of accounts) {
        try {
          // Implement token refresh logic for each platform
          // This is simplified - you'd need platform-specific refresh logic
          const refreshed = await this.refreshPlatformToken(account);
          if (refreshed) {
            refreshedAccounts.push(account);
          }
        } catch (error) {
          console.error(`Error refreshing ${account.platform} token:`, error);
        }
      }

      return refreshedAccounts;
    } catch (error) {
      console.error('Error refreshing tokens:', error);
      throw error;
    }
  }

  // Refresh platform-specific token
  async refreshPlatformToken(account) {
    // Implement platform-specific token refresh logic
    // This is a placeholder
    return true;
  }

  // Start scheduled post processor
  startScheduledPostProcessor() {
    // Check for scheduled posts every minute
    cron.schedule('* * * * *', async () => {
      try {
        const now = new Date();
        const { data: scheduledPosts, error } = await this.supabase
          .from('scheduled_posts')
          .select('*')
          .eq('status', 'scheduled')
          .lte('scheduled_time', now.toISOString());

        if (error) throw error;

        for (const post of scheduledPosts || []) {
          try {
            // Post to platforms
            const results = await this.postArticle(
              post.user_id,
              post.platforms,
              post.content,
              post.media
            );

            // Update status
            await this.supabase
              .from('scheduled_posts')
              .update({ 
                status: 'posted',
                posted_at: now.toISOString(),
                results: results
              })
              .eq('id', post.id);

          } catch (error) {
            console.error(`Error processing scheduled post ${post.id}:`, error);
            
            // Update status to failed
            await this.supabase
              .from('scheduled_posts')
              .update({ 
                status: 'failed',
                error: error.message
              })
              .eq('id', post.id);
          }
        }
      } catch (error) {
        console.error('Error in scheduled post processor:', error);
      }
    });
  }
}

module.exports = SocialMediaService;
