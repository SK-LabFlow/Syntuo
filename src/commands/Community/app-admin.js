import { SlashCommandBuilder, PermissionFlagsBits, PermissionsBitField, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ComponentType, LabelBuilder, RoleSelectMenuBuilder } from 'discord.js';
import { createEmbed, successEmbed } from '../../utils/embeds.js';
import { getColor, getApplicationStatusColor, getDefaultApplicationQuestions, STAFF_APPLICATION_QUESTIONS } from '../../config/bot.js';
import { logger } from '../../utils/logger.js';
import { withErrorHandling, createError, ErrorTypes, replyUserError } from '../../utils/errorHandler.js';
import ApplicationService from '../../services/applicationService.js';
import { 
    getApplicationSettings, 
    saveApplicationSettings, 
    getApplication, 
    getApplications, 
    updateApplication,
    getApplicationRoles,
    saveApplicationRoles,
    getApplicationRoleSettings,
    saveApplicationRoleSettings,
    deleteApplication
} from '../../utils/database.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import appDashboard from './modules/app_dashboard.js';

function getApplicationStatusPresentation(statusValue) {
    const normalized = typeof statusValue === 'string' ? statusValue.trim().toLowerCase() : 'unknown';
    const statusLabel =
        normalized === 'pending' ? 'In Progress' :
        normalized === 'approved' ? 'Accepted' :
        normalized === 'denied' ? 'Denied' :
        'Unknown';
    const statusEmoji =
        normalized === 'pending' ? '🟡' :
        normalized === 'approved' ? '🟢' :
        normalized === 'denied' ? '🔴' :
        '⚪';

    return { normalized, statusLabel, statusEmoji };
}

export default {
    data: new SlashCommandBuilder()
    .setName("app-admin")
    .setDescription("Manage staff applications")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((subcommand) =>
        subcommand
            .setName("setup")
            .setDescription("Set up a new application")
    )
    .addSubcommand((subcommand) =>
        subcommand
            .setName("review")
            .setDescription("Approve or deny an application")
            .addStringOption((option) =>
                option
                    .setName("id")
                    .setDescription("The application ID")
                    .setRequired(true),
            ),
    )
    .addSubcommand((subcommand) =>
        subcommand
            .setName("list")
            .setDescription("List all applications")
            .addStringOption((option) =>
                option
                    .setName("status")
                    .setDescription("Filter by status")
                    .addChoices(
                        { name: "Pending", value: "pending" },
                        { name: "Approved", value: "approved" },
                        { name: "Denied", value: "denied" },
                    ),
            )
            .addStringOption((option) =>
                option.setName("role").setDescription("Filter by role ID"),
            )
            .addUserOption((option) =>
                option.setName("user").setDescription("Filter by user"),
            )
            .addNumberOption((option) =>
                option
                    .setName("limit")
                    .setDescription(
                        "Maximum number of applications to show (default: 10)",
                    )
                    .setMinValue(1)
                    .setMaxValue(25),
            ),
    )
    .addSubcommand((subcommand) =>
        subcommand
            .setName("dashboard")
            .setDescription("Open the applications configuration dashboard")
            .addStringOption((option) =>
                option
                    .setName("application")
                    .setDescription("Select an application to configure")
                    .setRequired(false)
                    .setAutocomplete(true),
            ),
    )
    .addSubcommand((subcommand) =>
        subcommand
            .setName("panel")
            .setDescription("Send an application panel to a channel so members can click to apply")
            .addChannelOption((option) =>
                option
                    .setName("channel")
                    .setDescription("The channel where the application panel will be posted")
                    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                    .setRequired(true),
            )
            .addRoleOption((option) =>
                option
                    .setName("role")
                    .setDescription("The Discord role members will apply for (e.g. @Staff)")
                    .setRequired(false),
            )
            .addStringOption((option) =>
                option
                    .setName("application")
                    .setDescription("The application role to apply for (leave empty for default)")
                    .setRequired(false)
                    .setAutocomplete(true),
            )
            .addStringOption((option) =>
                option
                    .setName("title")
                    .setDescription("Custom panel title (default: Staff Application)")
                    .setRequired(false)
                    .setMaxLength(256),
            )
            .addStringOption((option) =>
                option
                    .setName("description")
                    .setDescription("Custom panel description / instructions")
                    .setRequired(false)
                    .setMaxLength(2000),
            )
            .addStringOption((option) =>
                option
                    .setName("button_text")
                    .setDescription("Custom button label (default: Apply for Staff)")
                    .setRequired(false)
                    .setMaxLength(80),
            ),
    )
    .addSubcommandGroup((group) =>
        group
            .setName("question")
            .setDescription("Manage application questions (all compulsory *)")
            .addSubcommand((sub) =>
                sub
                    .setName("add")
                    .setDescription("Add a new compulsory question (*)")
                    .addStringOption((opt) =>
                        opt
                            .setName("question")
                            .setDescription("The question text to ask applicants (max 300 characters)")
                            .setRequired(true)
                            .setMaxLength(300)
                    )
                    .addRoleOption((opt) =>
                        opt
                            .setName("role")
                            .setDescription("Target a specific application role (leave empty for global)")
                            .setRequired(false)
                    )
            )
            .addSubcommand((sub) =>
                sub
                    .setName("preset")
                    .setDescription("Load a question preset (e.g. staff application)")
                    .addStringOption((opt) =>
                        opt
                            .setName("name")
                            .setDescription("The preset template to load")
                            .setRequired(true)
                            .addChoices(
                                { name: "Staff Application (7 compulsory questions)", value: "staff" },
                            )
                    )
                    .addRoleOption((opt) =>
                        opt
                            .setName("role")
                            .setDescription("Target a specific application role (leave empty for global)")
                            .setRequired(false)
                    )
            )
            .addSubcommand((sub) =>
                sub
                    .setName("remove")
                    .setDescription("Remove a question by its number")
                    .addIntegerOption((opt) =>
                        opt
                            .setName("number")
                            .setDescription("The question number to remove (1, 2, 3...)")
                            .setRequired(true)
                            .setMinValue(1)
                    )
                    .addRoleOption((opt) =>
                        opt
                            .setName("role")
                            .setDescription("Target a specific application role (leave empty for global)")
                            .setRequired(false)
                    )
            )
            .addSubcommand((sub) =>
                sub
                    .setName("list")
                    .setDescription("List all configured application questions (all compulsory *)")
                    .addRoleOption((opt) =>
                        opt
                            .setName("role")
                            .setDescription("Target a specific application role (leave empty for global)")
                            .setRequired(false)
                    )
            )
            .addSubcommand((sub) =>
                sub
                    .setName("clear")
                    .setDescription("Reset questions back to default questions")
                    .addRoleOption((opt) =>
                        opt
                            .setName("role")
                            .setDescription("Target a specific application role (leave empty for global)")
                            .setRequired(false)
                    )
            )
    ),

    category: "Community",

    execute: withErrorHandling(async (interaction) => {
        if (!interaction.inGuild()) {
            return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'This command can only be used in a server.' });
        }

        const { options, guild, member } = interaction;
        const subcommandGroup = options.getSubcommandGroup(false);
        const subcommand = options.getSubcommand();

        if (subcommand !== 'dashboard' && subcommand !== 'setup') {
            await InteractionHelper.safeDefer(interaction, { flags: ['Ephemeral'] });
        }

        logger.info(`App-admin command executed: ${subcommandGroup ? `${subcommandGroup} ` : ''}${subcommand}`, {
            userId: interaction.user.id,
            guildId: guild.id,
            subcommandGroup,
            subcommand
        });

        await ApplicationService.checkManagerPermission(interaction.client, guild.id, member);

        if (subcommandGroup === "question") {
            await handleQuestionCommand(interaction);
            return;
        }

        if (subcommand === "panel") {
            await handlePanel(interaction);
        } else if (subcommand === "setup") {
            await handleSetup(interaction);
        } else if (subcommand === "review") {
            await handleReview(interaction);
        } else if (subcommand === "list") {
            await handleList(interaction);
        } else if (subcommand === "dashboard") {
            const selectedAppName = interaction.options.getString("application");
            await appDashboard.execute(interaction, null, interaction.client, selectedAppName);
        }
    }, { type: 'command', commandName: 'app-admin' })
};

async function handlePanel(interaction) {
    const { options, guild, client, member } = interaction;
    await ApplicationService.checkManagerPermission(client, guild.id, member);

    const targetChannel = options.getChannel('channel', true);
    const specifiedRole = options.getRole('role');
    const selectedAppName = options.getString('application');
    const customTitle = options.getString('title');
    const customDesc = options.getString('description');
    const customBtnText = options.getString('button_text');

    let applicationRoles = await getApplicationRoles(client, guild.id);
    const settings = await getApplicationSettings(client, guild.id);

    // If staff specified a role directly (e.g. role:@Staff), auto-register it if not already present
    if (specifiedRole) {
        let existingRole = applicationRoles.find(r => r.roleId === specifiedRole.id);
        if (!existingRole) {
            existingRole = {
                roleId: specifiedRole.id,
                name: specifiedRole.name,
                enabled: true
            };
            applicationRoles.push(existingRole);
            await saveApplicationRoles(client, guild.id, applicationRoles);

            const questions = settings.questions?.length ? settings.questions : getDefaultApplicationQuestions();
            await saveApplicationRoleSettings(client, guild.id, specifiedRole.id, { questions });
        }
        if (!settings.enabled) {
            await ApplicationService.updateSettings(client, guild.id, { enabled: true });
        }
    }

    if (!applicationRoles || applicationRoles.length === 0) {
        return await replyUserError(interaction, {
            type: ErrorTypes.CONFIGURATION,
            message: 'No application role is configured yet. You can either:\n' +
                '1️⃣ Specify the role directly: `/app-admin panel channel:#channel role:@Staff`\n' +
                '2️⃣ Or run `/app-admin setup` first to configure your application role.'
        });
    }

    let targetAppRole = null;
    if (specifiedRole) {
        targetAppRole = applicationRoles.find(r => r.roleId === specifiedRole.id);
    } else if (selectedAppName) {
        targetAppRole = applicationRoles.find(r => r.name.toLowerCase() === selectedAppName.toLowerCase());
        if (!targetAppRole) {
            return await replyUserError(interaction, {
                type: ErrorTypes.USER_INPUT,
                message: `Application "${selectedAppName}" not found. Configured applications: ${applicationRoles.map(r => `\`${r.name}\``).join(', ')}`
            });
        }
    } else if (applicationRoles.length === 1) {
        targetAppRole = applicationRoles[0];
    }

    const botMember = guild.members.me || await guild.members.fetchMe().catch(() => null);
    if (botMember && !targetChannel.permissionsFor(botMember)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
        return await replyUserError(interaction, {
            type: ErrorTypes.PERMISSION,
            message: `I lack permissions to send messages and embed links in ${targetChannel}. Please grant me the required permissions.`
        });
    }

    if (targetAppRole) {
        const roleSettings = await getApplicationRoleSettings(client, guild.id, targetAppRole.roleId);
        const questions = roleSettings.questions || settings.questions || getDefaultApplicationQuestions();

        const title = customTitle || `📋 ${targetAppRole.name} Application`;
        const description = customDesc || (
            `Interested in applying for **${targetAppRole.name}**?\n\n` +
            `• Click the button below to open the application form.\n` +
            `• There are **${questions.length} compulsory questions (*)** to answer.\n` +
            `• Please provide thorough, detailed, and honest answers.\n\n` +
            `*Your submission will be forwarded directly to server leadership for review.*`
        );

        const embed = createEmbed({
            title,
            description,
            color: 'primary'
        }).setFooter({ text: `${guild.name} Staff Applications • Click below to apply` });

        const btn = new ButtonBuilder()
            .setCustomId(`app_apply_btn_${targetAppRole.roleId}`)
            .setLabel(customBtnText || `Apply for ${targetAppRole.name}`)
            .setStyle(ButtonStyle.Success)
            .setEmoji('📝');

        const row = new ActionRowBuilder().addComponents(btn);

        const sentMsg = await targetChannel.send({
            embeds: [embed],
            components: [row]
        });

        return await InteractionHelper.safeEditReply(interaction, {
            embeds: [successEmbed(
                '✅ Application Panel Sent',
                `Successfully posted the application panel for **${targetAppRole.name}** into ${targetChannel}!\n\n` +
                `Members can now click the button to apply directly.\n` +
                `[Jump to Panel Message](${sentMsg.url})`
            )]
        });
    }

    const title = customTitle || `📋 Server Applications`;
    const description = customDesc || (
        `Welcome to our server application center!\n\n` +
        `Click any role button below to start your application.\n` +
        `All questions are **compulsory (*)** and will be reviewed by our administration team.`
    );

    const embed = createEmbed({
        title,
        description,
        color: 'primary'
    }).setFooter({ text: `${guild.name} Applications • Click a button to apply` });

    const buttons = applicationRoles.slice(0, 5).map(appRole =>
        new ButtonBuilder()
            .setCustomId(`app_apply_btn_${appRole.roleId}`)
            .setLabel(`Apply: ${appRole.name}`)
            .setStyle(ButtonStyle.Primary)
            .setEmoji('📝')
    );

    const row = new ActionRowBuilder().addComponents(buttons);

    const sentMsg = await targetChannel.send({
        embeds: [embed],
        components: [row]
    });

    return await InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed(
            '✅ Application Panel Sent',
            `Successfully posted the application panel with **${buttons.length} role(s)** into ${targetChannel}!\n\n` +
            `Members can now click the buttons to apply directly.\n` +
            `[Jump to Panel Message](${sentMsg.url})`
        )]
    });
}

async function handleQuestionCommand(interaction) {
    const { options, guild, client, member } = interaction;
    const sub = options.getSubcommand();
    const targetRole = options.getRole('role');
    const targetRoleId = targetRole?.id;

    await ApplicationService.checkManagerPermission(client, guild.id, member);

    const roles = await getApplicationRoles(client, guild.id);
    if (targetRoleId && !roles.some(r => r.roleId === targetRoleId)) {
        return await replyUserError(interaction, {
            type: ErrorTypes.USER_INPUT,
            message: `The role <@&${targetRoleId}> is not configured as an application role. Use \`/app-admin setup\` or add it in the dashboard first.`
        });
    }

    const settings = await getApplicationSettings(client, guild.id);
    let roleSettings = null;
    if (targetRoleId) {
        roleSettings = await getApplicationRoleSettings(client, guild.id, targetRoleId);
    }

    let questions = targetRoleId 
        ? (roleSettings.questions ?? settings.questions ?? getDefaultApplicationQuestions())
        : (settings.questions ?? getDefaultApplicationQuestions());
    
    questions = Array.isArray(questions) ? [...questions] : getDefaultApplicationQuestions();

    const targetLabel = targetRole ? `role **${targetRole.name}**` : '**Global (All Applications)**';

    if (sub === 'add') {
        const questionText = options.getString('question', true).trim();
        if (questionText.length < 3) {
            return await replyUserError(interaction, {
                type: ErrorTypes.VALIDATION,
                message: 'Question must be at least 3 characters long.'
            });
        }

        questions.push(questionText);

        if (targetRoleId) {
            await saveApplicationRoleSettings(client, guild.id, targetRoleId, {
                ...roleSettings,
                questions
            });
        } else {
            await saveApplicationSettings(client, guild.id, {
                ...settings,
                questions
            });
        }

        const embed = successEmbed(
            '✅ Compulsory Question Added',
            `Added compulsory question **#${questions.length}** to ${targetLabel}:\n\n` +
            `> "${questionText}" \\*\n\n` +
            `⭐ **Note:** All ${questions.length} question(s) are **compulsory (\\*)** for applicants.\n\n` +
            `**All Questions (${questions.length}):**\n` +
            questions.map((q, i) => `${i + 1}. ${q} \\*`).join('\n')
        );

        return await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
    }

    if (sub === 'remove') {
        const questionNum = options.getInteger('number', true);
        if (questionNum < 1 || questionNum > questions.length) {
            return await replyUserError(interaction, {
                type: ErrorTypes.USER_INPUT,
                message: `Invalid question number. Please choose a number between 1 and ${questions.length}.`
            });
        }

        if (questions.length <= 1) {
            return await replyUserError(interaction, {
                type: ErrorTypes.VALIDATION,
                message: 'You cannot remove the last question. Applications must have at least 1 compulsory question.'
            });
        }

        const [removed] = questions.splice(questionNum - 1, 1);

        if (targetRoleId) {
            await saveApplicationRoleSettings(client, guild.id, targetRoleId, {
                ...roleSettings,
                questions
            });
        } else {
            await saveApplicationSettings(client, guild.id, {
                ...settings,
                questions
            });
        }

        const embed = successEmbed(
            '🗑️ Question Removed',
            `Removed question **#${questionNum}** ("${removed}") from ${targetLabel}.\n\n` +
            `**Remaining Compulsory Questions (${questions.length}):**\n` +
            questions.map((q, i) => `${i + 1}. ${q} \\*`).join('\n')
        );

        return await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
    }

    if (sub === 'list') {
        const embed = createEmbed({
            title: `📝 Application Questions — ${targetRole ? targetRole.name : 'Global'}`,
            description: `Here are the questions configured for ${targetLabel}.\n\n` +
                `⭐ **All questions are compulsory (\\*) for applicants to answer.**\n\n` +
                `**Questions (${questions.length}):**\n` +
                questions.map((q, i) => `**${i + 1}.** ${q} \\*`).join('\n') +
                `\n\n💡 *Tip: Use \`/app-admin question add\` to add more questions, or \`/app-admin question remove\` to delete one.*`,
            color: 'info'
        });

        return await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
    }

    if (sub === 'clear') {
        const defaultQuestions = getDefaultApplicationQuestions();

        if (targetRoleId) {
            await saveApplicationRoleSettings(client, guild.id, targetRoleId, {
                ...roleSettings,
                questions: defaultQuestions
            });
        } else {
            await saveApplicationSettings(client, guild.id, {
                ...settings,
                questions: defaultQuestions
            });
        }

        const embed = successEmbed(
            '🔄 Questions Reset',
            `Reset questions for ${targetLabel} back to default (${defaultQuestions.length} compulsory questions):\n\n` +
            defaultQuestions.map((q, i) => `**${i + 1}.** ${q} \\*`).join('\n')
        );

        return await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
    }

    if (sub === 'preset') {
        const presetName = options.getString('name', true);
        let presetQuestions = [];
        let presetTitle = '';

        if (presetName === 'staff') {
            presetQuestions = [...STAFF_APPLICATION_QUESTIONS];
            presetTitle = 'Staff Application (7 Compulsory Questions)';
        }

        if (targetRoleId) {
            await saveApplicationRoleSettings(client, guild.id, targetRoleId, {
                ...roleSettings,
                questions: presetQuestions
            });
        } else {
            await saveApplicationSettings(client, guild.id, {
                ...settings,
                questions: presetQuestions
            });
        }

        const embed = successEmbed(
            '📋 Preset Loaded Successfully',
            `Loaded **${presetTitle}** for ${targetLabel}.\n\n` +
            `⭐ **All ${presetQuestions.length} questions are compulsory (\\*) for applicants.**\n\n` +
            `**Configured Questions:**\n` +
            presetQuestions.map((q, i) => `**${i + 1}.** ${q} \\*`).join('\n\n')
        );

        return await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
    }
}

async function handleSetup(interaction) {
    
    if (interaction.deferred || interaction.replied) {
        return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'This interaction has already been processed. Please try the command again.' });
    }

    const modal = new ModalBuilder()
        .setCustomId('app_setup_modal')
        .setTitle('Set Up New Application');

    const roleSelect = new RoleSelectMenuBuilder()
        .setCustomId('role_id')
        .setPlaceholder('Select the role users will apply for')
        .setRequired(true);

    const roleLabel = new LabelBuilder()
        .setLabel('Application Role')
        .setDescription('The role that users will be applying for')
        .setRoleSelectMenuComponent(roleSelect);

    const appNameInput = new TextInputBuilder()
        .setCustomId('app_name')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g., Moderator, Helper, Developer')
        .setMaxLength(50)
        .setMinLength(1)
        .setRequired(true);

    const appNameLabel = new LabelBuilder()
        .setLabel('Application Name')
        .setTextInputComponent(appNameInput);

    const q1Input = new TextInputBuilder()
        .setCustomId('app_question_1')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Why do you want this role?')
        .setMaxLength(100)
        .setMinLength(1)
        .setRequired(true);

    const q1Label = new LabelBuilder()
        .setLabel('Question 1 * (Compulsory)')
        .setTextInputComponent(q1Input);

    const q2Input = new TextInputBuilder()
        .setCustomId('app_question_2')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('What experience do you have?')
        .setMaxLength(100)
        .setRequired(false);

    const q2Label = new LabelBuilder()
        .setLabel('Question 2 * (Compulsory if added)')
        .setTextInputComponent(q2Input);

    const q3Input = new TextInputBuilder()
        .setCustomId('app_question_3')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g., How active can you be weekly?')
        .setMaxLength(100)
        .setRequired(false);

    const q3Label = new LabelBuilder()
        .setLabel('Question 3 * (Compulsory if added)')
        .setTextInputComponent(q3Input);

    modal.addLabelComponents(roleLabel, appNameLabel, q1Label, q2Label, q3Label);

    await interaction.showModal(modal);

    const submitted = await interaction.awaitModalSubmit({
        time: 15 * 60 * 1000, 
        filter: (i) =>
            i.customId === 'app_setup_modal' &&
            i.user.id === interaction.user.id,
    }).catch(() => null);

    if (!submitted) {
        logger.info('App setup modal dismissed or timed out', { guildId: interaction.guild.id, userId: interaction.user.id });
        return;
    }

    const appName = submitted.fields.getTextInputValue('app_name').trim();
    const selectedRoles = submitted.fields.getSelectedRoles('role_id');
    const roleId = selectedRoles.first()?.id;

    if (!roleId) {
        await replyUserError(submitted, { type: ErrorTypes.USER_INPUT, message: 'You must select a role for the application.' });
        return;
    }

    const questions = [
        submitted.fields.getTextInputValue('app_question_1').trim(),
        submitted.fields.getTextInputValue('app_question_2').trim(),
        submitted.fields.getTextInputValue('app_question_3').trim(),
    ].filter(q => q.length > 0);

    const role = await interaction.guild.roles.fetch(roleId).catch(() => null);
    if (!role) {
        await replyUserError(submitted, { type: ErrorTypes.VALIDATION, message: 'The selected role could not be found.' });
        return;
    }

    const existingRoles = await getApplicationRoles(interaction.client, interaction.guild.id);
    if (existingRoles.some(r => r.roleId === roleId)) {
        await replyUserError(submitted, { type: ErrorTypes.CONFIGURATION, message: `The role ${role} is already configured as an application.` });
        return;
    }

    existingRoles.push({
        roleId: roleId,
        name: appName,
        enabled: true,  
    });

    await saveApplicationRoles(interaction.client, interaction.guild.id, existingRoles);

    const settings = await getApplicationSettings(interaction.client, interaction.guild.id);
    if (!settings.enabled) {
        await ApplicationService.updateSettings(interaction.client, interaction.guild.id, { enabled: true });
    }

    const finalQuestions = questions.length > 0
        ? questions
        : (settings.questions?.length ? settings.questions : getDefaultApplicationQuestions());

    await saveApplicationRoleSettings(interaction.client, interaction.guild.id, roleId, { questions: finalQuestions });

    await submitted.reply({
        embeds: [successEmbed(
            '✅ Application Created',
            `**${appName}** application has been created for ${role} with **${finalQuestions.length} compulsory question(s) (*)**.\n\n` +
            `⭐ **Note:** Every question asked is **compulsory (*)** for applicants to answer.\n\n` +
            `💡 **Tip:** You can now post the click-to-apply panel using:\n` +
            `• \`/app-admin panel channel:#your-channel application:${appName}\`\n\n` +
            `You can also manage settings and questions in the dashboard below.`,
        )],
        flags: ['Ephemeral'],
    });

    setTimeout(() => {
        appDashboard.execute(submitted, null, interaction.client, appName);
    }, 500);
}

async function handleReview(interaction) {
    const appId = interaction.options.getString("id");

    const application = await getApplication(
        interaction.client,
        interaction.guild.id,
        appId,
    );
    if (!application) {
        return await replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: 'Application not found.' });
    }

    if (application.status !== "pending") {
        return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'This application has already been processed.' });
    }

    const appEmbed = createEmbed({
        title: `Review Application`,
        description: `**User:** <@${application.userId}>\n**Application:** ${application.roleName}\n**Application ID:** \`${appId}\``,
        color: 'info',
    });

    if (application.answers && application.answers.length > 0) {
        application.answers.forEach((item, index) => {
            const qTitle = `Q${index + 1}: ${item.question}`;
            appEmbed.addFields({
                name: qTitle.length > 256 ? `${qTitle.substring(0, 253)}...` : qTitle,
                value: (item.answer || '*No answer provided*').substring(0, 1024),
                inline: false
            });
        });
    }

    const buttonRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`app_review_approve_${appId}`)
            .setLabel('Approve')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(`app_review_deny_${appId}`)
            .setLabel('Deny')
            .setStyle(ButtonStyle.Danger),
    );

    await InteractionHelper.safeEditReply(interaction, {
        embeds: [appEmbed],
        components: [buttonRow],
        flags: ["Ephemeral"],
    });

    const collector = interaction.channel.createMessageComponentCollector({
        componentType: ComponentType.Button,
        filter: i =>
            i.user.id === interaction.user.id &&
            (i.customId.startsWith(`app_review_approve_${appId}`) ||
             i.customId.startsWith(`app_review_deny_${appId}`)),
        time: 300_000, 
        max: 1,
    });

    collector.on('collect', async buttonInteraction => {
        const isApprove = buttonInteraction.customId.includes('approve');

        const reasonModal = new ModalBuilder()
            .setCustomId(`app_review_reason_${appId}_${isApprove ? 'approve' : 'deny'}`)
            .setTitle(`${isApprove ? 'Approve' : 'Deny'} Application - Reason`);

        reasonModal.addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('review_reason')
                    .setLabel('Reason (optional)')
                    .setStyle(TextInputStyle.Paragraph)
                    .setPlaceholder('Provide a reason for this decision...')
                    .setMaxLength(500)
                    .setRequired(false),
            ),
        );

        await buttonInteraction.showModal(reasonModal);

        try {
            const reasonSubmit = await buttonInteraction.awaitModalSubmit({
                time: 5 * 60 * 1000, 
                filter: i =>
                    i.customId === `app_review_reason_${appId}_${isApprove ? 'approve' : 'deny'}` &&
                    i.user.id === buttonInteraction.user.id,
            }).catch(() => null);

            if (!reasonSubmit) return;

            const reason = reasonSubmit.fields.getTextInputValue('review_reason').trim() || "No reason provided.";
            const action = isApprove ? 'approve' : 'deny';
            const status = isApprove ? 'approved' : 'denied';

            const updatedApplication = await ApplicationService.reviewApplication(
                reasonSubmit.client,
                interaction.guild.id,
                appId,
                {
                    action,
                    reason,
                    reviewerId: reasonSubmit.user.id
                }
            );

            try {
                const user = await reasonSubmit.client.users.fetch(application.userId);
                const statusColor = getApplicationStatusColor(status);
                const reviewStatus = getApplicationStatusPresentation(status);
                const dmEmbed = createEmbed({
                    title: `${reviewStatus.statusEmoji} Application ${reviewStatus.statusLabel}`,
                    description: `Your application for **${application.roleName}** has been **${status}**\n` +
                        `**Note:** ${reason}\n\n` +
                        `Use \`/apply status id:${appId}\` to view details.`
                }).setColor(statusColor);

                await user.send({ embeds: [dmEmbed] });
            } catch (error) {
                logger.warn('Failed to send DM to user for application review', {
                    error: error.message,
                    userId: application.userId,
                    applicationId: appId
                });
            }

            if (application.logMessageId && application.logChannelId) {
                try {
                    const statusColor = getApplicationStatusColor(status);
                    const logChannel = interaction.guild.channels.cache.get(
                        application.logChannelId,
                    );
                    if (logChannel) {
                        const logMessage = await logChannel.messages.fetch(
                            application.logMessageId,
                        );
                        if (logMessage) {
                            const embed = logMessage.embeds[0];
                            if (embed) {
                                const reviewStatus = getApplicationStatusPresentation(status);
                                const newEmbed = EmbedBuilder.from(embed)
                                    .setColor(statusColor)
                                    .spliceFields(0, 1, {
                                        name: "Status",
                                        value: `${reviewStatus.statusEmoji} ${reviewStatus.statusLabel}`,
                                    });

                                await logMessage.edit({
                                    embeds: [newEmbed],
                                    components: [],
                                });
                            }
                        }
                    }
                } catch (error) {
                    logger.warn('Failed to update log message for application', {
                        error: error.message,
                        applicationId: appId,
                        logMessageId: application.logMessageId
                    });
                }
            }

            if (isApprove) {
                try {
                    const member = await interaction.guild.members.fetch(
                        application.userId,
                    );
                    await member.roles.add(application.roleId);
                } catch (error) {
                    logger.error('Failed to assign role to approved applicant', {
                        error: error.message,
                        userId: application.userId,
                        roleId: application.roleId,
                        applicationId: appId
                    });
                }
            }

            await reasonSubmit.reply({
                embeds: [
                    successEmbed(
                        `Application ${status}`,
                        `The application has been **${status}**.`,
                    ),
                ],
                flags: ["Ephemeral"],
            });

        } catch (error) {
            logger.error('Error reviewing application:', error);
            await replyUserError(buttonInteraction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while reviewing the application.' });
        }
    });

    collector.on('end', async (collected, reason) => {
        if (reason === 'time') {
            const timeoutEmbed = createEmbed({
                title: 'Review Timeout',
                description: 'The review buttons have timed out.',
                color: 'warning',
            });

            await InteractionHelper.safeEditReply(interaction, {
                embeds: [timeoutEmbed],
                components: [],
            }).catch(() => {});
        }
    });
}

async function handleList(interaction) {
    const status = interaction.options.getString("status");
    const user = interaction.options.getUser("user");
    const limit = interaction.options.getNumber("limit") || 10;

    const filters = {};
    
    if (status) {
        filters.status = status;
    } else {
        filters.status = 'pending';
    }

    let applications = await getApplications(
        interaction.client,
        interaction.guild.id,
        filters,
    );

    if (!user) {
        applications = await Promise.all(
            applications.map(async (app) => {
                try {
                    await interaction.guild.members.fetch(app.userId);
                    return app; 
                } catch {
                    
                    await deleteApplication(interaction.client, interaction.guild.id, app.id, app.userId);
                    return null; 
                }
            })
        ).then(results => results.filter(Boolean)); 
    }

    if (user) {
        applications = applications.filter((app) => app.userId === user.id);
    }

    if (applications.length === 0) {
        const applicationRoles = await getApplicationRoles(interaction.client, interaction.guild.id);
        
        if (applicationRoles.length > 0) {
            const embed = createEmbed({ 
                title: "No Applications Found", 
                description: "No submitted applications found matching the specified criteria.\n\nHowever, the following application roles are configured:" 
            });

            applicationRoles.forEach((appRole, index) => {
                const role = interaction.guild.roles.cache.get(appRole.roleId);
                embed.addFields({
                    name: `${index + 1}. ${appRole.name}`,
                    value: `**Role:** ${role ?`<@&${appRole.roleId}>`: 'Role not found'}\n**Available for applications:** Yes`,
                    inline: false
                });
            });

            embed.setFooter({
                text: "Users can apply with /apply submit or see available roles with /apply list"
            });

            return InteractionHelper.safeEditReply(interaction, { embeds: [embed], flags: ["Ephemeral"] });
        } else {
            return await replyUserError(interaction, {
                type: ErrorTypes.CONFIGURATION,
                message: 'No applications found and no application roles configured.\n' +
                    'Use `/app-admin roles add` to configure application roles first.'
            });
        }
    }

    applications = applications
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, limit);

    const embed = createEmbed({ title: "Submitted Applications", description: `Showing ${applications.length} applications.`, });

    applications.forEach((app) => {
        const statusView = getApplicationStatusPresentation(app?.status);
        const roleName = app?.roleName || 'Unknown Role';
        const username = app?.username || 'Unknown User';
        const createdAt = app?.createdAt ? new Date(app.createdAt) : null;
        const createdAtDisplay = createdAt && !Number.isNaN(createdAt.getTime())
            ? createdAt.toLocaleString()
            : 'Unknown date';

        embed.addFields({
            name: `${statusView.statusEmoji} ${roleName} - ${username}`,
            value:
                `**ID:** \`${app.id}\`\n` +
                `**Status:** ${statusView.statusEmoji} ${statusView.statusLabel}\n` +
                `**Date:** ${createdAtDisplay}`,
            inline: true,
        });
    });

    await InteractionHelper.safeEditReply(interaction, {
        embeds: [embed],
        flags: ["Ephemeral"],
    });
}

